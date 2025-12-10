// server.js
import 'dotenv/config';
import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import FormData from "form-data";
import fs from "fs";
import cors from "cors";
import { Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

const upload = multer({ dest: "uploads/" });

const APP_ID = process.env.MATHPIX_APP_ID || "sarvajnaandjusticeshivarajpatilpucollege_32fc00_c50abe";
const APP_KEY = process.env.MATHPIX_APP_KEY || "389d59b96cdb62afd693865383e49a4bce0d9a1666d0117b49855c53dba69391";

/* Upload PDF to Mathpix */
async function uploadToMathpix(filePath) {
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));
  form.append("options_json", JSON.stringify({
    include_latex: true,
    include_text_data: true,
    formats: ["text", "math", "mmd"],
    math_inline_delimiters: ["$", "$"],
    math_display_delimiters: ["$$", "$$"],
    rm_spaces: true,
    enable_tables_fallback: true
  }));

  const r = await fetch("https://api.mathpix.com/v3/pdf", {
    method: "POST",
    headers: { app_id: APP_ID, app_key: APP_KEY, ...form.getHeaders() },
    body: form
  });

  return JSON.parse(await r.text());
}

/* Poll job */
async function pollStatus(pdf_id) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const res = await fetch(`https://api.mathpix.com/v3/pdf/${pdf_id}`, {
      headers: { app_id: APP_ID, app_key: APP_KEY },
    });
    const json = await res.json();
    if (json.status === "completed") return json;
    if (json.status === "error") throw new Error("Mathpix failed");
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("Timeout waiting for Mathpix");
}

/* Fetch MMD */
async function getMmdContent(pdf_id) {
  const res = await fetch(`https://api.mathpix.com/v3/pdf/${pdf_id}.mmd`, {
    headers: { app_id: APP_ID, app_key: APP_KEY, Accept: "text/plain" },
  });
  return res.text();
}

/* Clean MMD */
function cleanMmdText(mmd) {
  if (!mmd) return "";
  let s = mmd.replace(/\r\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.replace(/\$\$([\s\S]*?)\$\$/g, "\\($1\\)");
  s = s.replace(/\\\[(.*?)\\\]/gs, "\\($1\\)");
  s = s.replace(/\$([^$]+?)\$/g, "\\($1\\)");
  s = s.replace(/^\\section\*{.*}$/gm, "");
  s = s.replace(/Answer Key[\s\S]*$/i, "");
  return s.trim();
}

function extractAnswerKey(mmd) {
  const answerSection = mmd.split(/Answer Key[:]?/i)[1];
  if (!answerSection) return {};

  const keyLines = answerSection.split(/\n/).map(l => l.trim());

  const answerMap = {};

  keyLines.forEach(line => {
    const parts = line.match(/(\d+)\)\s*([A-D])/gi);
    if (parts) {
      parts.forEach(p => {
        const m = p.match(/(\d+)\)\s*([A-D])/i);
        if (m) {
          answerMap[m[1]] = m[2].toLowerCase();
        }
      });
    }
  });

  return answerMap;
}


/* Parse into questions + options */
function parseQuestions(cleaned) {
  const lines = cleaned
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);

  const questions = [];
  let current = null;

  // ✅ SUPER FLEXIBLE question detection
  const qStart = /^(\d{1,3})\s*[.)-]?\s+(.*)$/;

  // ✅ SUPER FLEXIBLE option detection for Mathpix OCR
  const optRe = /^(?:\(|\[)?\s*([a-dA-D1-4])\s*(?:\)|\]|\.|\))?\s+(.*)$/;

  for (const line of lines) {
    const qMatch = line.match(qStart);

    if (qMatch) {
      if (current) questions.push(current);

      current = {
        number: Number(qMatch[1]),
        stem: qMatch[2],
        options: []
      };
      continue;
    }

    const oMatch = line.match(optRe);
    if (current && oMatch) {
      let rawLabel = oMatch[1].toLowerCase();

      // ✅ convert 1–4 to a–d
      const numToAlpha = { "1": "a", "2": "b", "3": "c", "4": "d" };
      const finalLabel = numToAlpha[rawLabel] || rawLabel;

      current.options.push({
        label: finalLabel,
        text: oMatch[2]
      });
      continue;
    }

    // ✅ multi-line continuation support
    if (current) {
      if (current.options.length > 0) {
        current.options[current.options.length - 1].text += " " + line;
      } else {
        current.stem += " " + line;
      }
    }
  }

  if (current) questions.push(current);
  return questions;
}




/* Build LaTeX (unchanged) */
function generateLatexQuestions(questions) {
  return questions.map(q => {
    const opts = q.options
      .map(o => `${o.label}. ${o.text}`)
      .join("\n");
    return `${q.number}. ${q.stem}\n${opts}`;
  }).join("\n\n");
}

/* Build full LaTeX (unchanged) */
function createLatexDocument(latexQuestions) {
  return `
\\documentclass[12pt]{article}
\\usepackage{amsmath}
\\usepackage{amssymb}
\\usepackage{geometry}
\\geometry{margin=1in}

\\begin{document}
\\section*{Questions}

${latexQuestions}

\\end{document}
`.trim();
}

/* Convert API (unchanged) */
app.post("/api/convert", upload.single("pdf"), async (req, res) => {
  const filePath = req.file?.path;
  try {
    const uploaded = await uploadToMathpix(filePath);
    const pdf_id = uploaded.pdf_id;

    const status = await pollStatus(pdf_id);
    const mmd = await getMmdContent(pdf_id);
    const answerMap = extractAnswerKey(mmd);
    const cleaned = cleanMmdText(mmd);
    const questions = parseQuestions(cleaned);

    // attach answer to each question
    questions.forEach(q => {
      q.answer = answerMap[q.number] || "";
    });


    const latex_questions = generateLatexQuestions(questions);
    const latex_document = createLatexDocument(latex_questions);

    fs.unlinkSync(filePath);

    res.json({
      success: true,
      pdf_id,
      questions,
      cleaned_text: cleaned,
      raw_mmd: mmd,
      latex_questions,
      latex_document
    });
  } catch (err) {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.status(500).json({ error: err.message });
  }
});

/* ---------------------------- */
/* UPDATED: DOWNLOAD DOCX ENDPOINT */
/* ---------------------------- */
app.post("/api/download-docx", async (req, res) => {
  const { questions } = req.body;

  // Create table rows
  const tableRows = [
    // Header row
    new TableRow({
      children: [
        new TableCell({ children: [new Paragraph("Sr. No.")], width: { size: 5, type: WidthType.PERCENTAGE } }),
        new TableCell({ children: [new Paragraph("Question")], width: { size: 25, type: WidthType.PERCENTAGE } }),
        new TableCell({ children: [new Paragraph("Option A")], width: { size: 10, type: WidthType.PERCENTAGE } }),
        new TableCell({ children: [new Paragraph("Option B")], width: { size: 10, type: WidthType.PERCENTAGE } }),
        new TableCell({ children: [new Paragraph("Option C")], width: { size: 10, type: WidthType.PERCENTAGE } }),
        new TableCell({ children: [new Paragraph("Option D")], width: { size: 10, type: WidthType.PERCENTAGE } }),
        new TableCell({ children: [new Paragraph("Ans Key")], width: { size: 5, type: WidthType.PERCENTAGE } }),
        new TableCell({ children: [new Paragraph("Solution")], width: { size: 15, type: WidthType.PERCENTAGE } }),
        new TableCell({ children: [new Paragraph("Tage")], width: { size: 5, type: WidthType.PERCENTAGE } }),
        new TableCell({ children: [new Paragraph("Medium")], width: { size: 5, type: WidthType.PERCENTAGE } }),
      ],
    }),
    // Separator row (like the +=====+ line in your sample)
    new TableRow({
      children: [
        new TableCell({ children: [new Paragraph("")] }),
        new TableCell({ children: [new Paragraph("")] }),
        new TableCell({ children: [new Paragraph("")] }),
        new TableCell({ children: [new Paragraph("")] }),
        new TableCell({ children: [new Paragraph("")] }),
        new TableCell({ children: [new Paragraph("")] }),
        new TableCell({ children: [new Paragraph("")] }),
        new TableCell({ children: [new Paragraph("")] }),
        new TableCell({ children: [new Paragraph("")] }),
        new TableCell({ children: [new Paragraph("")] }),
      ],
    }),
  ];

  // Add question rows
  questions.forEach((q) => {
    tableRows.push(
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph(q.number.toString())] }),
          new TableCell({ children: [new Paragraph(q.stem)] }),
          new TableCell({ children: [new Paragraph(q.options.find(opt => opt.label === 'a')?.text || "")] }),
          new TableCell({ children: [new Paragraph(q.options.find(opt => opt.label === 'b')?.text || "")] }),
          new TableCell({ children: [new Paragraph(q.options.find(opt => opt.label === 'c')?.text || "")] }),
          new TableCell({ children: [new Paragraph(q.options.find(opt => opt.label === 'd')?.text || "")] }),
          new TableCell({ children: [new Paragraph(q.answer.toUpperCase())] }),

          new TableCell({ children: [new Paragraph("")] }), // Empty Solution
          new TableCell({ children: [new Paragraph("NEET TEST -- 01 (2024)")] }), // Default Tage
          new TableCell({ children: [new Paragraph("Easy")] }), // Default Medium
        ],
      })
    );
  });

  const doc = new Document({
    sections: [
      {
        children: [
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: tableRows,
          }),
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);

  res.setHeader("Content-Disposition", "attachment; filename=questions.docx");
  res.setHeader("Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
  res.send(buffer);
});

app.listen(4000, () =>
  console.log("Backend running on http://localhost:4000")
);