// App.jsx
import React, { useState } from "react";
import { InlineMath } from "react-katex";
import "katex/dist/katex.min.css";
import he from "he";

export default function App() {
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState("readable");

  const convert = async () => {
    if (!file) return setError("Please upload a PDF");

    setLoading(true);
    setError("");
    setResult(null);

    const form = new FormData();
    form.append("pdf", file);

    try {
      const res = await fetch("http://localhost:4000/api/convert", {
        method: "POST",
        body: form
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setResult(json);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  const renderMixedMath = (text) => {
    if (!text) return null;
    const s = he.decode(text);
    const regex = /\\\((.*?)\\\)/g;

    const parts = [];
    let last = 0;
    let m, i = 0;

    while ((m = regex.exec(s)) !== null) {
      if (m.index > last) parts.push(<span key={last}>{s.slice(last, m.index)}</span>);
      parts.push(<InlineMath key={i} math={m[1]} />);
      last = regex.lastIndex;
      i++;
    }
    if (last < s.length) parts.push(<span key={last}>{s.slice(last)}</span>);
    return <span>{parts}</span>;
  };

  const renderReadable = () => (
    <div style={{ padding: 20 }}>
      <h3>Readable Version (Exam Style)</h3>

      {result.questions.map((q) => (
        <div key={q.number} style={{ marginBottom: 20 }}>
          <div>
            <strong>{q.number}. </strong>
            {renderMixedMath(q.stem)}
          </div>
          <div style={{ marginTop: 10 }}>
            {q.options.map((opt) => (
              <div key={opt.label} style={{ display: "flex", marginBottom: 5 }}>
                <div style={{ width: 30 }}>{opt.label}.</div>
                <div>{renderMixedMath(opt.text)}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );

  const renderFormattedLatex = () => (
    <pre style={{ whiteSpace: "pre-wrap", padding: 20 }}>
      {result.latex_questions}
    </pre>
  );

  const renderLatexDocument = () => (
    <pre style={{
      whiteSpace: "pre-wrap",
      background: "#222",
      color: "#fff",
      padding: 20
    }}>
      {result.latex_document}
    </pre>
  );

  const renderRaw = () => (
    <pre style={{ whiteSpace: "pre-wrap", padding: 20 }}>
      {JSON.stringify(result, null, 2)}
    </pre>
  );

  return (
    <div style={{ maxWidth: 1100, margin: "20px auto" }}>
      <h1>PDF → Exam Style & LaTeX Converter</h1>

      <input type="file" accept="application/pdf"
        onChange={(e) => setFile(e.target.files[0])} />

      <button onClick={convert} disabled={loading}>
        {loading ? "Converting..." : "Convert"}
      </button>

      {error && <div style={{ color: "red" }}>{error}</div>}

      {result && (
        <>
          {/* NEW DOWNLOAD BUTTON */}
          <button
            style={{ marginTop: 15, marginBottom: 10, marginLeft: 10,padding: "8px 16px" }}
            onClick={async () => {
              const res = await fetch("http://localhost:4000/api/download-docx", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ questions: result.questions }),
              });

              const blob = await res.blob();
              const url = window.URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "questions.docx";
              a.click();
              window.URL.revokeObjectURL(url);
            }}
          >
            Download DOCX
          </button>

          <div style={{ marginTop: 20, display: "flex", background: "#eee" }}>
            <button onClick={() => setActiveTab("readable")} style={{ flex: 1 }}>
              Readable Version
            </button>
            <button onClick={() => setActiveTab("formatted")} style={{ flex: 1 }}>
              Formatted LaTeX
            </button>
            <button onClick={() => setActiveTab("document")} style={{ flex: 1 }}>
              LaTeX Document
            </button>
            <button onClick={() => setActiveTab("raw")} style={{ flex: 1 }}>
              Raw JSON
            </button>
          </div>

          <div>
            {activeTab === "readable" && renderReadable()}
            {activeTab === "formatted" && renderFormattedLatex()}
            {activeTab === "document" && renderLatexDocument()}
            {activeTab === "raw" && renderRaw()}
          </div>
        </>
      )}
    </div>
  );
}
