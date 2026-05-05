// server.js
import 'dotenv/config';
import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import FormData from "form-data";
import fs from "fs";
import cors from "cors";
import { Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

const upload = multer({ dest: "uploads/" });

// Mathpix credentials
const APP_ID = process.env.MATHPIX_APP_ID || "sarvajnaandjusticeshivarajpatilpucollege_32fc00_c50abe";
const APP_KEY = process.env.MATHPIX_APP_KEY || "389d59b96cdb62afd693865383e49a4bce0d9a1666d0117b49855c53dba69391";

// Gemini AI setup
const genAI = new GoogleGenerativeAI('AIzaSyAnJvf4fizsN_vS49_JJjCxN38Mm_mb8NA');
const model = genAI.getGenerativeModel({ model: "gemini-3.1-pro-preview" });

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

  const optionRegex = /([a-dA-D])\.\s*(\!\[[^\]]*?\]\([^)]*?\))/g;
  const options = [];
  let cleanedStem = text;
  let match;

  while ((match = optionRegex.exec(text)) !== null) {
    options.push({
      label: match[1].toLowerCase(),
      text: match[2].trim(),
    });
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
  s = s.replace(/\bI\s+([a-z])/g, (m, p1) => p1.toUpperCase());
  s = s.replace(/\b1\s+([a-z])/g, "$1");
  s = s.replace(/\bT\s+hree\b/g, "Three");
  s = s.replace(/\bF\s+our\b/g, "Four");
  s = s.replace(/\bS\s+even\b/g, "Seven");
 
  return s.trim();
}

function extractAnswerKey(mmd) {
  const answerMap = {};
  const startIndex = mmd.search(/Answers/i);
  if (startIndex === -1) return {};

  let textToParse = mmd.slice(Math.max(0, startIndex - 200));
  textToParse = textToParse
    .replace(/\\begin\{.*?\}/g, "")
    .replace(/\\end\{.*?\}/g, "")
    .replace(/\\hline/g, "")
    .replace(/\$/g, "")
    .replace(/&/g, " ")
    .replace(/\\\\/g, " ")
    .replace(/\s+/g, " ");

  const regex = /(\d{1,3})\s*(?:&|\s)*\s*\(?\$?\(?\s*([A-Da-d])\s*\)?\$?\)?/g;
  let match;

  while ((match = regex.exec(textToParse)) !== null) {
    const qNum = Number(match[1]);
    const ans = match[2].toLowerCase();
    if (qNum >= 1 && qNum <= 122) {
      answerMap[qNum] = ans;
    }
  }

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

  const qStart = /^(\d{1,3})[\.\)]?\s+(.*)/;
  const optRe = /^\(?\s*([a-dA-D1-4])\s*[\)\.]?\s+(.*)$/;

  for (const line of lines) {
    if (/\\begin\{table\}/i.test(line)) {
      break;
    }
    if (/Answers/i.test(line)) {
      break;
    }
    
    const qMatch = line.match(qStart);
    const oMatch = line.match(optRe);

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

    if (qMatch) {
      const qNum = Number(qMatch[1]);
      const qText = qMatch[2];
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

    if (current && oMatch) {
      let label = oMatch[1].toLowerCase();
      const text = oMatch[2].trim();
      if (["1", "2", "3", "4"].includes(label)) {
        label = String.fromCharCode(96 + Number(label));
      }
      const exists = current.options.find(o => o.label === label);
      if (!exists) {
        current.options.push({ label, text });
        continue;
      }
    }

    if (current) {
      if (current.options.length > 0) {
        if (/\\begin\{table\}/i.test(line) ||
          /Mastering NCERT|Answers|NEET Special/i.test(line)) {
          continue;
        }
        current.options[current.options.length - 1].text += " " + line;
      } else {
        current.stem += " " + line;
      }
    }
  }

  if (current) questions.push(current);
  return questions;
}

function normalizeInlineOptions(text) {
  let s = text;
  s = s.replace(/\bT\s+hree\b/g, "Three");
  s = s.replace(/\bF\s+our\b/g, "Four");
  s = s.replace(/\bS\s+even\b/g, "Seven");
  s = s.replace(/([^\n])\s+(\d{1,3})[\.\)]\s+/g, "$1\n$2 ");
  s = s.replace(/\(\s*([1-4])\s*\)/g, "\n($1) ");
  s = s.replace(/([^\n])\s+\(\s*([1-4])\s*\)\s+/g, "$1\n($2) ");
  s = s.replace(/\(\s*([a-dA-D])\s*\)/g, "\n($1) ");
  return s;
}

/* GEMINI AI: Verify and correct questions and options */
async function verifyWithGemini(questions) {
  console.log("🤖 Sending questions to Gemini AI for verification...");
  
  const verifiedQuestions = [];
  
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    
    // Prepare the prompt for Gemini
    const prompt = `
You are an expert educational content reviewer. Please verify and correct the following multiple choice question.

Current Question Data:
Question Number: ${q.number}
Question Stem: ${q.stem}
Options:
A) ${q.options.find(opt => opt.label === 'a')?.text || 'Missing'}
B) ${q.options.find(opt => opt.label === 'b')?.text || 'Missing'}
C) ${q.options.find(opt => opt.label === 'c')?.text || 'Missing'}
D) ${q.options.find(opt => opt.label === 'd')?.text || 'Missing'}
Current Answer Key: ${q.answer || 'Not specified'}

Please analyze this question and:
1. Check if the question stem is grammatically correct and makes sense
2. Verify that all options are relevant and properly formatted
3. Identify if there are any OCR errors, missing punctuation, or formatting issues
4. Determine the correct answer based on the content
5. Suggest improvements if needed

Return a JSON object in this exact format:
{
  "verified": true/false,
  "correctedStem": "fixed question stem text",
  "correctedOptions": {
    "a": "fixed option a text",
    "b": "fixed option b text", 
    "c": "fixed option c text",
    "d": "fixed option d text"
  },
  "suggestedAnswer": "a/b/c/d",
  "issues": ["list of issues found"],
  "suggestions": ["list of suggestions"]
}

If no corrections are needed, return the original text in the "corrected" fields.
`;

    try {
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();
      
      // Extract JSON from the response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const correction = JSON.parse(jsonMatch[0]);
        
        // Apply corrections
        const correctedQuestion = {
          ...q,
          stem: correction.correctedStem || q.stem,
          options: [
            { label: 'a', text: correction.correctedOptions?.a || q.options.find(opt => opt.label === 'a')?.text || '' },
            { label: 'b', text: correction.correctedOptions?.b || q.options.find(opt => opt.label === 'b')?.text || '' },
            { label: 'c', text: correction.correctedOptions?.c || q.options.find(opt => opt.label === 'c')?.text || '' },
            { label: 'd', text: correction.correctedOptions?.d || q.options.find(opt => opt.label === 'd')?.text || '' }
          ],
          answer: correction.suggestedAnswer || q.answer,
          geminiVerified: correction.verified,
          geminiIssues: correction.issues || [],
          geminiSuggestions: correction.suggestions || []
        };
        
        verifiedQuestions.push(correctedQuestion);
        console.log(`✅ Question ${q.number} verified by Gemini`);
        
        if (correction.issues?.length > 0) {
          console.log(`   Issues found: ${correction.issues.join(', ')}`);
        }
      } else {
        // If JSON parsing fails, keep original
        console.log(`⚠️ Could not parse Gemini response for question ${q.number}, keeping original`);
        verifiedQuestions.push({ ...q, geminiVerified: false, geminiError: "Failed to parse response" });
      }
      
      // Add a small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
      
    } catch (error) {
      console.error(`❌ Error verifying question ${q.number} with Gemini:`, error.message);
      verifiedQuestions.push({ ...q, geminiVerified: false, geminiError: error.message });
    }
  }
  
  console.log("🎉 Gemini verification completed!");
  return verifiedQuestions;
}

/* Build LaTeX */
function generateLatexQuestions(questions) {
  return questions.map(q => {
    const opts = q.options
      .map(o => `${o.label}. ${o.text}`)
      .join("\n");
    return `${q.number}. ${q.stem}\n${opts}`;
  }).join("\n\n");
}

/* Build full LaTeX */
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

/* Convert API with Gemini integration */
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
    cleaned = normalizeInlineOptions(cleaned);
    let questions = parseQuestions(cleaned);

    // attach answer to each question
    questions.forEach(q => {
      q.answer = answerMap[q.number] || "";
    });

    // NEW: Verify and correct questions with Gemini AI
    console.log("🔍 Starting Gemini AI verification...");
    const verifiedQuestions = await verifyWithGemini(questions);
    console.log("✅ Gemini verification complete!");

    const latex_questions = generateLatexQuestions(verifiedQuestions);
    const latex_document = createLatexDocument(latex_questions);

    fs.unlinkSync(filePath);

    res.json({
      success: true,
      pdf_id,
      questions: verifiedQuestions, // Send verified questions
      original_questions: questions, // Also send original for comparison if needed
      cleaned_text: cleaned,
      raw_mmd: mmd,
      latex_questions,
      latex_document,
      gemini_enabled: true
    });
  } catch (err) {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.status(500).json({ error: err.message });
  }
});

// New endpoint: Manual verification of specific question
app.post("/api/verify-question", async (req, res) => {
  const { question } = req.body;
  
  try {
    const prompt = `
Verify this multiple choice question:
Question: ${question.stem}
Options:
A: ${question.options.find(o => o.label === 'a')?.text}
B: ${question.options.find(o => o.label === 'b')?.text}
C: ${question.options.find(o => o.label === 'c')?.text}
D: ${question.options.find(o => o.label === 'd')?.text}
Current Answer: ${question.answer}

Return JSON with corrections if any.
`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const correction = JSON.parse(jsonMatch[0]);
      res.json({ success: true, correction });
    } else {
      res.json({ success: false, error: "Could not parse response" });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* Download DOCX endpoint */
app.post("/api/download-docx", async (req, res) => {
  const { questions } = req.body;

  const tableRows = [
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
          new TableCell({ children: [new Paragraph(q.answer?.toUpperCase() || "")] }),
          new TableCell({ children: [new Paragraph("")] }),
          new TableCell({ children: [new Paragraph("NEET TEST -- 01 (2024)")] }),
          new TableCell({ children: [new Paragraph("Easy")] }),
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