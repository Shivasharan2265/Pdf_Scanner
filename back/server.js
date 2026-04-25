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

function extractInlineOptions(text) {
  if (!text.includes("![")) {
    return { cleanedStem: text.trim(), options: [] };
  }

  // Match: a. ![](any_url_with_any_chars)
  const optionRegex = /([a-dA-D])\.\s*(\!\[[^\]]*?\]\([^)]*?\))/g;

  const options = [];
  let cleanedStem = text;
  let match;

  while ((match = optionRegex.exec(text)) !== null) {
    options.push({
      label: match[1].toLowerCase(),
      text: match[2].trim(),
    });

    // Remove this option from stem
    cleanedStem = cleanedStem.replace(match[0], "");
  }

  return {
    cleanedStem: cleanedStem.replace(/\s+/g, " ").trim(),
    options,
  };
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
  s = s.replace(/\\begin\{table\}[\s\S]*?\\end\{table\}/g, "");

  // Fix common OCR mistakes
s = s.replace(/\bI\s+([a-z])/g, (m, p1) => p1.toUpperCase()); // I hree → Three
s = s.replace(/\b1\s+([a-z])/g, "$1"); // 1 hree → hree
s = s.replace(/\b([A-Za-z])\s+([a-z]{2,})/g, "$1$2"); // T hree → Three
 
  return s.trim();
}

function extractAnswerKey(mmd) {
  const answerMap = {};

  const startIndex = mmd.search(/Answers/i);
  if (startIndex === -1) return {};

  // 🔥 include buffer before Answers
  const answerText = mmd.slice(Math.max(0, startIndex - 200));


  // ✅ use full text (no limit)
 let textToParse = answerText;

// 🔥 remove latex table junk
textToParse = textToParse
  .replace(/\\begin\{.*?\}/g, "")
  .replace(/\\end\{.*?\}/g, "")
  .replace(/\\hline/g, "")
  .replace(/\$/g, "")
  .replace(/&/g, " ")
  .replace(/\\\\/g, " ")
  .replace(/\s+/g, " ");


 // 🔍 DEBUG HERE
  console.log("TEXT LENGTH:", textToParse.length);
  console.log("LAST PART OF TEXT:\n", textToParse.slice(-500));

const regex = /(\d{1,3})\s*(?:&|\s)*\s*\(?\$?\(?\s*([A-Da-d])\s*\)?\$?\)?/g;

  let match;
while ((match = regex.exec(textToParse)) !== null) {
    const qNum = Number(match[1]);
    const ans = match[2].toLowerCase();

    if (qNum >= 1 && qNum <= 122) {
      answerMap[qNum] = ans;
    }
  }

  // 🔥 fallback for Q1
  if (!answerMap[1]) {
    const fallbackMatch = mmd.match(/1\s*[\.\:\-\)]?\s*\(?\s*([A-Da-d])\s*\)?/);
    if (fallbackMatch) {
      answerMap[1] = fallbackMatch[1].toLowerCase();
    }
  }

  return answerMap;
}




/* Parse into questions + options */
function parseQuestions(cleaned) {
  const lines = cleaned.split("\n").map(l => l.trim()).filter(Boolean);
  const questions = [];
  let current = null;

  // Pattern for Question: Matches "31. Text" or "31 Text"
const qStart = /^(\d{1,3})[\.\)]?\s+(.*)/;
  // Pattern for Option: Matches "(a) Text" or "a. Text"
const optRe = /^\(?\s*([a-dA-D1-4])\s*[\)\.]?\s+(.*)$/;

  for (const line of lines) {
     // 🚨 STOP when table starts
  if (/\\begin\{table\}/i.test(line)) {
    break;
  }
  // 🚨 STOP when answers section starts
  if (/Answers/i.test(line)) {
    break;
  }
    const qMatch = line.match(qStart);
    const oMatch = line.match(optRe);

    // 🔥 FIX: detect missed question when options already full
if (current && current.options.length === 4 && !oMatch) {
  const forcedQ = line.match(/^(\d{1,3})\s+(.*)/);

  if (forcedQ) {
    questions.push(current);

    current = {
      number: Number(forcedQ[1]),
      stem: forcedQ[2],
      options: []
    };

    continue;
  }
}

    // --- CASE 1: NEW QUESTION DETECTED ---
    if (qMatch) {
      const qNum = Number(qMatch[1]);
      const qText = qMatch[2];

      // If we already have a question, push it to the list
      if (current) {
        questions.push(current);
      }

      current = {
        number: qNum,
        stem: qText,
        options: []
      };
      continue;
    }

    // --- CASE 2: OPTION DETECTED ---
if (current && oMatch) {
  let label = oMatch[1].toLowerCase();
  const text = oMatch[2].trim();

  // 🔥 convert 1,2,3,4 → a,b,c,d
  if (["1", "2", "3", "4"].includes(label)) {
    label = String.fromCharCode(96 + Number(label)); // 1→a
  }

  const exists = current.options.find(o => o.label === label);
  if (!exists) {
    current.options.push({ label, text });
    continue;
  }
}

    // --- CASE 3: CONTINUATION TEXT ---
    if (current) {
  if (current.options.length > 0) {

  // 🚨 Ignore answer/table junk
  if (
    /\\begin\{table\}/i.test(line) ||
    /Mastering NCERT|Answers|NEET Special/i.test(line)
  ) {
    continue;
  }

  current.options[current.options.length - 1].text += " " + line;
} else {
        // Add text to the question stem
        current.stem += " " + line;
      }
    }
  }

  // Push the final question
  if (current) questions.push(current);
  
  return questions;
}

function normalizeInlineOptions(text) {
  let s = text;

  // Fix broken OCR words
  s = s.replace(/\b([A-Za-z])\s+([a-z]{2,})/g, "$1$2");

  // 🔥 Ensure question numbers start on new line
  s = s.replace(/([^\n])\s+(\d{1,3})[\.\)]\s+/g, "$1\n$2 ");

  // 🔥 Convert (1)(2)(3)(4) → newline separated
  s = s.replace(/\(\s*([1-4])\s*\)/g, "\n($1) ");

  // 🔥 Convert inline options like " (1) A (2) B"
  s = s.replace(/([^\n])\s+\(\s*([1-4])\s*\)\s+/g, "$1\n($2) ");

  // 🔥 Handle a,b,c,d also
  s = s.replace(/\(\s*([a-dA-D])\s*\)/g, "\n($1) ");

  return s;
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
    console.log("ANSWER MAP:", answerMap);
let cleaned = cleanMmdText(mmd);
cleaned = normalizeInlineOptions(cleaned);   // 🔥 CRITICAL LINE
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