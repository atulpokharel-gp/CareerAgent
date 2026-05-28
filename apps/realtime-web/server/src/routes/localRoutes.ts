import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import {
  getTrackedJobs,
  getJobStats,
  markJobStatus,
  loadUserData,
} from "../services/persistentStorage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Absolute path to the pre-loaded CV PDF (null on Vercel — users upload their own)
const CV_PATH = config.cvPdfPath;

export async function registerLocalRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Returns the preloaded OpenAI API key and confirms a CV file is available.
   * Only intended for local development — never expose in production.
   */
  app.get("/api/local/init", async (_request, reply) => {
    const apiKey = process.env.OPENAI_API_KEY ?? "";
    let hasCv = false;
    try {
      if (CV_PATH) {
        await fs.access(CV_PATH);
        hasCv = true;
      }
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
  app.get("/api/local/cv", async (_request, reply) => {    if (!CV_PATH) return reply.code(404).send({ message: "No preloaded CV in this environment — upload your own." });    try {
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
  const OUTPUT_DIR = config.outputDir;

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

  // ── Persistent job database endpoints ─────────────────────────────────────
  // These read directly from user-data.json on disk — no active session needed.
  // The UI can call these on startup to restore the full history.

  /**
   * GET /api/data/jobs?status=shortlisted|applied|rejected|skipped
   * Returns all tracked jobs, optionally filtered by status.
   * Sorted newest-first.
   */
  app.get("/api/data/jobs", async (request, reply) => {
    const { status } = request.query as { status?: string };
    const validStatuses = ["shortlisted", "applied", "rejected", "skipped"];
    const filter = validStatuses.includes(status ?? "") ? (status as "shortlisted" | "applied" | "rejected" | "skipped") : undefined;
    const jobs = await getTrackedJobs(filter);
    // newest first
    const sorted = jobs.slice().sort((a, b) => b.scannedAt - a.scannedAt);
    return reply.send({ jobs: sorted, total: sorted.length });
  });

  /**
   * GET /api/data/jobs/stats
   * Aggregate counts per status for the dashboard.
   */
  app.get("/api/data/jobs/stats", async (_request, reply) => {
    const stats = await getJobStats();
    return reply.send(stats);
  });

  /**
   * PATCH /api/data/jobs/:encodedUrl
   * Manually update a job's status (e.g. user marks a job as "rejected" or "skipped").
   * :encodedUrl is encodeURIComponent(jobUrl).
   */
  app.patch("/api/data/jobs/:encodedUrl", async (request, reply) => {
    const { encodedUrl } = request.params as { encodedUrl: string };
    const { status } = request.body as { status?: string };
    const jobUrl = decodeURIComponent(encodedUrl);
    const validStatuses = ["shortlisted", "applied", "rejected", "skipped"];
    if (!validStatuses.includes(status ?? "")) {
      return reply.code(400).send({ error: `status must be one of: ${validStatuses.join(", ")}` });
    }
    await markJobStatus(jobUrl, status as "shortlisted" | "applied" | "rejected" | "skipped");
    return reply.send({ ok: true, jobUrl, status });
  });

  /**
   * GET /api/data/applications
   * Returns full apply records from persistent storage.
   */
  app.get("/api/data/applications", async (_request, reply) => {
    const data = await loadUserData();
    const sorted = data.applications.slice().sort((a, b) => b.submittedAt - a.submittedAt);
    return reply.send({ applications: sorted, total: sorted.length });
  });

  /**
   * DELETE /api/data/jobs/seen
   * Reset the "already seen" filter so the next scan re-evaluates all jobs.
   * Useful for debugging or when the user wants a fresh scan of old portals.
   * Only resets shortlisted jobs — applied/rejected records are preserved.
   */
  app.delete("/api/data/jobs/seen", async (_request, reply) => {
    const { default: nodeFs } = await import("node:fs/promises");
    const { default: nodePath } = await import("node:path");
    const dataPath = nodePath.join(config.dataDir, "user-data.json");
    try {
      const raw = await nodeFs.readFile(dataPath, "utf8");
      const data = JSON.parse(raw);
      const before = (data.trackedJobs ?? []).length;
      // Keep applied/rejected, remove shortlisted (they'll re-appear in next scan)
      data.trackedJobs = (data.trackedJobs ?? []).filter(
        (j: { status: string }) => j.status === "applied" || j.status === "rejected",
      );
      const after = data.trackedJobs.length;
      data.lastUpdated = Date.now();
      await nodeFs.writeFile(dataPath, JSON.stringify(data, null, 2), "utf8");
      return reply.send({ ok: true, removed: before - after, kept: after });
    } catch {
      return reply.send({ ok: true, removed: 0, kept: 0 });
    }
  });
}
