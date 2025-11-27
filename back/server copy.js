// server.js
import 'dotenv/config';
import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import FormData from "form-data";
import fs from "fs";
import cors from "cors";
import path from "path";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

const upload = multer({ dest: "uploads/" });

const APP_ID = process.env.MATHPIX_APP_ID || "sarvajnaandjusticeshivarajpatilpucollege_32fc00_c50abe";
const APP_KEY = process.env.MATHPIX_APP_KEY || "389d59b96cdb62afd693865383e49a4bce0d9a1666d0117b49855c53dba69391";

/* Upload to Mathpix */
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
    headers: {
      app_id: APP_ID,
      app_key: APP_KEY,
      ...form.getHeaders()
    },
    body: form
  });

  const text = await r.text();
  // Try to parse JSON (Mathpix sends JSON); if not parseable, return the raw text for debugging
  try {
    const json = JSON.parse(text);
    return json;
  } catch (e) {
    throw new Error(`Mathpix returned non-JSON response: ${text.slice(0, 400)}`);
  }
}

/* Poll */
async function pollStatus(pdf_id, maxAttempts = 40) {
  let attempts = 0;
  while (attempts < maxAttempts) {
    const res = await fetch(`https://api.mathpix.com/v3/pdf/${pdf_id}`, {
      headers: { app_id: APP_ID, app_key: APP_KEY }
    });
    const json = await res.json();
    if (json.status === "completed") return json;
    if (json.status === "error") throw new Error("Mathpix processing failed: " + JSON.stringify(json));
    // wait
    await new Promise(r => setTimeout(r, 1500 + attempts * 100)); // small backoff
    attempts++;
  }
  throw new Error("Timeout waiting for Mathpix processing");
}

/* Get MMD */
async function getMmdContent(pdf_id) {
  const res = await fetch(`https://api.mathpix.com/v3/pdf/${pdf_id}.mmd`, {
    headers: { app_id: APP_ID, app_key: APP_KEY, Accept: "text/plain" }
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error("Failed to fetch MMD: " + res.status + " " + t);
  }
  return await res.text();
}

/* Clean MMD lightly */
function cleanMmdText(mmd) {
  if (!mmd) return "";
  let s = mmd.replace(/\r\n/g, "\n");

  // Remove multiple blank lines
  s = s.replace(/\n{3,}/g, "\n\n");

  // Convert $$...$$ → inline math
  s = s.replace(/\$\$([\s\S]*?)\$\$/g, "\\($1\\)");

  // Convert display \[...\] → inline math
  s = s.replace(/\\\[(.*?)\\\]/gs, "\\($1\\)");

  // Convert single $...$ → inline math
  s = s.replace(/\$([^$]+?)\$/g, "\\($1\\)");

  // Remove section markers and answer key
  s = s.replace(/^\\section\*{.*}$/mg, "");
  s = s.replace(/Answer Key[\s\S]*$/i, "");

  return s.trim();
}


/* Parse into structured questions */
function parseQuestions(cleanedText) {
  const lines = cleanedText.split("\n");
  const questions = [];
  let current = null;

  const qStartRe = /^\s*(\d{1,3})\s*(?:[.)])\s*(.*)$/;      // 1.  or 1) 
  const optRe = /^\s*(?:\(?([a-dA-D])\)?[\s.)-]*)\s*(.*)$/; // a. or (a) or a)

  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const qMatch = line.match(qStartRe);
    const oMatch = line.match(optRe);

    if (qMatch && !/^[a-dA-D][\s.)-]/.test(qMatch[2])) {
      // starts a new question (ensures not option-like)
      if (current) questions.push(current);
      current = { number: parseInt(qMatch[1], 10), stem: qMatch[2] || "", options: [] };
      continue;
    }

    // If line begins with a known option label and we have a question, treat as option
    if (current && oMatch && /^[a-dA-D]([\s.)-]|$)/.test(line)) {
      const label = oMatch[1].toLowerCase();
      const text = oMatch[2] || "";
      current.options.push({ label, text });
      continue;
    }

    // Heuristic: if current exists and line contains multiple options inline (a. ... b. ... c. ...)
    if (current) {
      const inlineSplit = line.split(/\s+(?=[a-dA-D]\s*[.)])/);
      if (inlineSplit.length > 1 && /^[a-dA-D]\s*[.)]/.test(inlineSplit[0])) {
        for (const part of inlineSplit) {
          const m = part.match(optRe);
          if (m) current.options.push({ label: m[1].toLowerCase(), text: m[2] || "" });
        }
        continue;
      }
      // Continuation: if options exist, append to last option, else append to stem
      if (current.options.length > 0) {
        const last = current.options[current.options.length - 1];
        last.text = (last.text ? last.text + " " : "") + line;
      } else {
        current.stem = (current.stem ? current.stem + " " : "") + line;
      }
      continue;
    }

    // fallback: if line begins with number but didn't match qStartRe, create a question
    const alt = line.match(/^\s*(\d{1,3})\s+(.*)$/);
    if (alt) {
      if (current) questions.push(current);
      current = { number: parseInt(alt[1], 10), stem: alt[2] || "", options: [] };
    }
  }
if (current) questions.push(current);

// Beautify stems: Put (A), (B), (C) on new lines
questions.forEach(q => {
  q.stem = (q.stem || "")
    .replace(/\s*\(A\)\s*/g, "\n(A) ")
    .replace(/\s*\(B\)\s*/g, "\n(B) ")
    .replace(/\s*\(C\)\s*/g, "\n(C) ")
    .replace(/\s*\(D\)\s*/g, "\n(D) ")
    .trim();
});

// Final formatting
return questions.map(q => ({
  number: q.number,
  stem: q.stem,
  options: q.options.map(o => ({
    label: o.label,
    text: (o.text || "").trim()
  }))
}));

}

/* POST /api/convert */
app.post("/api/convert", upload.single("pdf"), async (req, res) => {
  const filePath = req.file?.path;
  if (!filePath) return res.status(400).json({ error: "No file uploaded (field name must be 'pdf')" });

  try {
    console.log("Upload file:", filePath);
    const uploadResp = await uploadToMathpix(filePath);
    if (!uploadResp.pdf_id) {
      // return server response for debugging
      fs.unlinkSync(filePath);
      return res.status(500).json({ error: "No pdf_id in Mathpix response", uploadResp });
    }

    const pdf_id = uploadResp.pdf_id;
    console.log("pdf_id:", pdf_id);

    // poll
    const status = await pollStatus(pdf_id);
    console.log("status object:", status.status);

    const mmd = await getMmdContent(pdf_id);
    const cleaned = cleanMmdText(mmd);
    const questions = parseQuestions(cleaned);

    // remove uploaded file
    try { fs.unlinkSync(filePath); } catch(e){}

    return res.json({
      success: true,
      pdf_id,
      uploaded_response: uploadResp,
      status,
      raw_mmd: mmd,
      cleaned_text: cleaned,
      questions
    });
  } catch (err) {
    console.error("Conversion error:", err);
    try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch(e){}
    return res.status(500).json({ error: err.message, stack: err.stack?.toString?.(), hint: "See server logs" });
  }
});

/* health */
app.get("/api/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
