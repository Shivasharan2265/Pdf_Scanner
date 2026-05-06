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

// THIS IS THE LATEST

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
// Fix only known OCR mistakes
s = s.replace(/\bT\s+hree\b/g, "Three");
s = s.replace(/\bF\s+our\b/g, "Four");
s = s.replace(/\bS\s+even\b/g, "Seven");
 
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




function normalizeInlineOptions(text) {
  let s = text;

  // 1. Fix broken OCR words
  s = s.replace(/\bT\s+hree\b/g, "Three");
  s = s.replace(/\bF\s+our\b/g, "Four");
  s = s.replace(/\bS\s+even\b/g, "Seven");

  // 2. Protect Roman Numerals (I, II, III, IV, V) from being treated as new questions
  // We ensure they have a space or newline but don't force a "New Question" break
  s = s.replace(/([^\n])\s+([IVX]{1,3})\.\s+/g, "$1\n$2. ");

  // 3. Ensure question numbers start on new line, but ONLY if followed by actual text
  s = s.replace(/([^\n])\s+(\d{1,3})[\.\)]\s+/g, "$1\n$2. ");

  // 4. SMART OPTION SPLITTING
  // Only split if there is a significant gap (2+ spaces) OR it's a clear list format
  // This prevents (a) from jumping to a new line if it was already correctly placed.
  s = s.replace(/\s{2,}\(?\s*([b-dB-D2-4])\s*[\)\.]/g, "\n($1)");
  s = s.replace(/([^\n]{20,})\s{2,}\(?\s*([a-dA-D1-4])\s*[\)\.]/g, "$1\n($2)");

  return s;
}

function parseQuestions(cleaned, optionType) {
  const lines = cleaned.split("\n").map(l => l.trim()).filter(Boolean);
  const questions = [];
  let current = null;

  const qStart = /^(\d{1,3})[\.\)]?\s+(.*)/;
  
  let optRe;
  if (optionType === "a.") optRe = /^([a-d])\.\s+(.*)$/i;
  else if (optionType === "(a)") optRe = /^\(([a-d])\)\s+(.*)$/i;
  else if (optionType === "1.") optRe = /^([1-4])\.\s+(.+)$/;
  else if (optionType === "(1)") optRe = /^\(([1-4])\)\s+(.*)$/;
  else if (optionType === "A.") optRe = /^([A-D])\.\s+(.*)$/;
  else if (optionType === "(A)") optRe = /^\(([A-D])\)\s+(.*)$/;
  else optRe = /^\(?\s*([a-dA-D1-4])\s*[\)\.]?\s+(.*)$/i;

  for (const line of lines) {
    if (/\\begin\{table\}/i.test(line) || /Answers/i.test(line)) break;

    // Filter out OCR junk like standalone "Q1" or "Q94" that break flow
   const qOnlyMatch = line.match(/^Q(\d{1,3})$/i);

if (qOnlyMatch) {
  const qNum = Number(qOnlyMatch[1]);

  // Start new question ONLY if previous question has options (means it's complete)
  if (current && current.options.length > 0) {
    questions.push(current);
    current = { number: qNum, stem: "", options: [] };
  } else if (!current) {
    current = { number: qNum, stem: "", options: [] };
  }

  continue;
}
let oMatch = line.match(optRe);
let qMatch = line.match(qStart);

// 🔥 CRITICAL FIX: if option type is numeric, prioritize option match
if ((optionType === "1." || optionType === "(1)") && oMatch) {
  qMatch = null; // prevent it from becoming a question
}

    // If we find a question number, but we are already in a question and haven't found options yet,
    // check if it's actually a new question or just a list item (like 1. II. III.)
if (qMatch) {
  const qNum = Number(qMatch[1]);
  const qText = qMatch[2];

  if (current) {

    const isNextSequential =
      qNum === current.number + 1;

    // ------------------------------------------------
    // Detect Numerical-Type Questions
    // ------------------------------------------------
    const isNumericalQuestion =
      current.options.length === 0 &&
      (
        current.stem.includes("____") ||
        current.stem.includes("_____") ||
        /is\s+equal\s+to/i.test(current.stem) ||
        /minimum\s+value/i.test(current.stem) ||
        /value\s+of/i.test(current.stem)
      );

    // ------------------------------------------------
    // CASE 1:
    // MCQ without options yet → continuation
    // ------------------------------------------------
    if (
      current.options.length === 0 &&
      !isNumericalQuestion
    ) {
      current.stem += " " + qMatch[0];
      continue;
    }

    // ------------------------------------------------
    // CASE 2:
    // Numerical question → allow next sequential
    // ------------------------------------------------
    if (isNumericalQuestion && isNextSequential) {
      questions.push(current);

      current = {
        number: qNum,
        stem: qText,
        options: []
      };

      continue;
    }

    // ------------------------------------------------
    // CASE 3:
    // OCR junk like accidental "1."
    // ------------------------------------------------
    if (
      qNum === 1 &&
      current.number > 5 &&
      current.options.length === 0
    ) {
      current.stem += " " + qText;
      continue;
    }

    // ------------------------------------------------
    // Default New Question
    // ------------------------------------------------
    questions.push(current);
  }

  current = {
    number: qNum,
    stem: qText,
    options: []
  };

  continue;
}
    if (current && oMatch) {
      let label = oMatch[1].toLowerCase();
      const text = oMatch[2].trim();
      if (["1", "2", "3", "4"].includes(label)) {
        label = String.fromCharCode(96 + Number(label));
      }

      // Check for duplicate labels (happens with "Both (a) and (b)")
      const exists = current.options.find(o => o.label === label);
      if (exists) {
        current.options[current.options.length - 1].text += " " + line;
      } else {
        current.options.push({ label, text });
      }
      continue;
    }

    if (current) {
      if (current.options.length > 0) {
        current.options[current.options.length - 1].text += " " + line;
      } else {
        // Append Roman numeral lists or continued text to the stem
        current.stem += "\n" + line; 
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
  const { optionType } = req.body; // Catch from frontend
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
const questions = parseQuestions(cleaned, optionType);


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