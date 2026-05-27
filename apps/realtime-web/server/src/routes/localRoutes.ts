import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Absolute path to the cv/ folder at the repo root
const CV_PATH = path.join(config.repoRoot, "cv", "startup_v4.pdf");

export async function registerLocalRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Returns the preloaded OpenAI API key and confirms a CV file is available.
   * Only intended for local development — never expose in production.
   */
  app.get("/api/local/init", async (_request, reply) => {
    const apiKey = process.env.OPENAI_API_KEY ?? "";
    let hasCv = false;
    try {
      await fs.access(CV_PATH);
      hasCv = true;
    } catch { /* file not found */ }

    return reply.send({
      apiKey,
      provider: "openai",
      hasCv,
    });
  });

  /**
   * Streams the preloaded CV PDF from the repo's cv/ folder.
   * The browser-side pdf.js parser will extract the text.
   */
  app.get("/api/local/cv", async (_request, reply) => {
    try {
      const buf = await fs.readFile(CV_PATH);
      return reply
        .header("Content-Disposition", "inline; filename=\"startup_v4.pdf\"")
        .type("application/pdf")
        .send(buf);
    } catch {
      return reply.code(404).send({ message: "Preloaded CV not found at cv/startup_v4.pdf" });
    }
  });

  /**
   * Serve generated output files (LaTeX, HTML CVs).
   * Files are written to apps/realtime-web/output/ by cvLatexGenerator.
   */
  const OUTPUT_DIR = path.join(config.repoRoot, "apps", "realtime-web", "output");

  app.get("/api/output/:filename", async (request, reply) => {
    const { filename } = request.params as { filename: string };
    // Security: only allow safe filenames — no path traversal
    if (!/^[\w\-.]+$/.test(filename) || filename.includes("..")) {
      return reply.code(400).send({ message: "Invalid filename" });
    }
    const filePath = path.join(OUTPUT_DIR, filename);
    try {
      const buf = await fs.readFile(filePath);
      const ext = path.extname(filename).toLowerCase();
      const mime =
        ext === ".pdf" ? "application/pdf" :
        ext === ".tex" ? "application/x-tex" :
        ext === ".html" ? "text/html" :
        "application/octet-stream";
      return reply
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .type(mime)
        .send(buf);
    } catch {
      return reply.code(404).send({ message: `File not found: ${filename}` });
    }
  });

  /** List available output files */
  app.get("/api/output", async (_request, reply) => {
    try {
      await fs.mkdir(OUTPUT_DIR, { recursive: true });
      const files = await fs.readdir(OUTPUT_DIR);
      const cvFiles = files
        .filter((f) => f.startsWith("cv-") && (f.endsWith(".tex") || f.endsWith(".html")))
        .sort()
        .reverse()
        .slice(0, 50);
      return reply.send({ files: cvFiles });
    } catch {
      return reply.send({ files: [] });
    }
  });
}
