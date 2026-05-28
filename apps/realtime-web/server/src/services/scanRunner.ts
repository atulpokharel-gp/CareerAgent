import { spawn } from "node:child_process";
import path from "node:path";
import PQueue from "p-queue";
import type { FastifyBaseLogger } from "fastify";
import type { JobItem, SessionEvent } from "../types.js";
import { IS_VERCEL } from "../config.js";

const OFFER_LINE = /^\s*\+\s+([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*(https?:\/\/\S+)\s*$/;

export class ScanRunner {
  private readonly queue: PQueue;

  constructor(private readonly repoRoot: string, concurrency: number) {
    this.queue = new PQueue({ concurrency, timeout: 1000 * 60 * 12, throwOnTimeout: true });
  }

  runScan(options: {
    verify: boolean;
    company?: string;
    onEvent: (event: SessionEvent) => void;
    logger: FastifyBaseLogger;
  }): Promise<JobItem[]> {
    return this.queue.add(async () => {
      // Portal scanning spawns a child process (node scan.mjs) which is not available
      // in a Vercel serverless environment. Return an empty result with an info message.
      if (IS_VERCEL) {
        options.onEvent({
          type: "status",
          message: "Portal scanning is not available in the hosted environment. Clone the repo locally to run full scans.",
          at: Date.now(),
        });
        return [];
      }

      const args = ["scan.mjs", "--dry-run"];
      if (options.verify) {
        args.push("--verify");
      }
      if (options.company && options.company.trim().length > 0) {
        args.push("--company", options.company.trim());
      }

      const jobs: JobItem[] = [];
      const dedupe = new Set<string>();
      const child = spawn("node", args, {
        cwd: this.repoRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      options.onEvent({ type: "status", message: "Starting portal scan", at: Date.now() });

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      child.stdout.on("data", (chunk: string) => {
        for (const rawLine of chunk.split(/\r?\n/)) {
          const line = rawLine.trimEnd();
          if (!line) continue;
          options.onEvent({ type: "scan_line", line, at: Date.now() });

          const match = line.match(OFFER_LINE);
          if (!match) {
            continue;
          }

          const job: JobItem = {
            company: match[1].trim(),
            title: match[2].trim(),
            location: match[3].trim(),
            url: match[4].trim(),
          };
          const key = `${job.company}::${job.title}::${job.url}`.toLowerCase();
          if (dedupe.has(key)) {
            continue;
          }

          dedupe.add(key);
          jobs.push(job);
          options.onEvent({ type: "job_found", job, at: Date.now() });
        }
      });

      child.stderr.on("data", (chunk: string) => {
        for (const rawLine of chunk.split(/\r?\n/)) {
          const line = rawLine.trimEnd();
          if (!line) continue;
          options.onEvent({ type: "scan_line", line: `stderr: ${line}`, at: Date.now() });
        }
      });

      const exitCode = await new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });

      if (exitCode !== 0) {
        options.logger.error({ exitCode }, "scan.mjs failed");
        throw new Error(`scan.mjs exited with code ${exitCode}`);
      }

      options.onEvent({ type: "scan_done", count: jobs.length, at: Date.now() });
      return jobs;
    }) as Promise<JobItem[]>;
  }
}
