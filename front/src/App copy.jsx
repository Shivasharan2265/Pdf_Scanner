// App.jsx
import React, { useState } from "react";
import { InlineMath, BlockMath } from "react-katex";
import "katex/dist/katex.min.css";
import he from "he";

export default function App() {
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const onFileChange = (e) => {
    setFile(e.target.files?.[0] || null);
    setResult(null);
    setError("");
  };

  const convert = async () => {
    if (!file) {
      setError("Please select a PDF file first");
      return;
    }
    setLoading(true);
    setError("");
    setResult(null);

    const form = new FormData();
    // IMPORTANT: field name must be 'pdf' to match multer(upload.single("pdf"))
    form.append("pdf", file);

    try {
      const res = await fetch("http://localhost:4000/api/convert", {
        method: "POST",
        body: form
      });

      const json = await res.json();
      if (!res.ok) {
        setError(json?.error || "Server error");
        setResult(json); // show debug info even on error
      } else {
        setResult(json);
      }
    } catch (err) {
      console.error("Fetch error:", err);
      setError(err.message || "Network error");
    }
    setLoading(false);
  };

  // Renders strings with \(..\) or \[..\] tokens into React nodes
  const renderMixedMath = (text, key = "") => {
    if (!text) return null;
    const s = he.decode(text);
  
    const parts = [];
    let last = 0;
  
    const regex = /\\\((.*?)\\\)/g;
    let m, i = 0;
  
    while ((m = regex.exec(s)) !== null) {
      if (m.index > last) parts.push(<span key={last}>{s.slice(last, m.index)}</span>);
      parts.push(<InlineMath key={`m-${i}`} math={m[1].trim()} />);
      last = regex.lastIndex;
      i++;
    }
  
    if (last < s.length) parts.push(<span key={last}>{s.slice(last)}</span>);
  
    return <span>{parts}</span>;
  };
  

  const renderReadable = () => {
    if (!result?.questions) return null;
    return (
      <div style={{ marginTop: 20, padding: 20, background: "#fffbe6", borderRadius: 8 }}>
        <h3>Readable Version (Exam Style)</h3>
        {result.questions.map((q, i) => (
          <div key={i} style={{ marginBottom: 18, padding: 14, background: "#fff", borderRadius: 6 }}>
            <div style={{ marginBottom: 10 }}>
              <strong style={{ marginRight: 8 }}>{q.number}.</strong>
              <span>{renderMixedMath(q.stem, `q-${i}`)}</span>
            </div>
            <div>
              {q.options.length > 0 ? q.options.map((opt, oi) => (
                <div key={oi} style={{ display: "flex", marginBottom: 8 }}>
                  <div style={{ width: 28, fontWeight: "600" }}>{opt.label}.</div>
                  <div style={{ flex: 1 }}>{renderMixedMath(opt.text, `q-${i}-o-${oi}`)}</div>
                </div>
              )) : <div style={{ color: "#666" }}>No options parsed for this question.</div>}
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div style={{ maxWidth: 1000, margin: "12px auto", padding: 16 }}>
      <h1>PDF → Readable Exam Style</h1>

      <div style={{ padding: 12, background: "#fff", borderRadius: 8 }}>
        <input type="file" accept="application/pdf" onChange={onFileChange} />
        <button onClick={convert} disabled={loading} style={{ marginLeft: 12 }}>
          {loading ? "Converting..." : "Convert"}
        </button>
        <div style={{ marginTop: 8 }}>
          <strong>Note:</strong> field name must be <code>pdf</code>. Backend runs on <code>http://localhost:4000</code>.
        </div>
      </div>

      {error && (
        <div style={{ marginTop: 12, padding: 12, background: "#ffe6e6", borderRadius: 6 }}>
          <strong style={{ color: "#c00" }}>Error:</strong> {error}
        </div>
      )}

      {result && (
        <div style={{ marginTop: 12 }}>
          {renderReadable()}

          <div style={{ marginTop: 18 }}>
            <h4>Server response (debug)</h4>
            <pre style={{ background: "#f6f6f6", padding: 12, borderRadius: 6, maxHeight: 320, overflow: "auto" }}>
              {JSON.stringify(result, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
