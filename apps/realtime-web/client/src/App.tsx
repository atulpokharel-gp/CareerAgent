import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { bulkSubmitApplications, configureAutomation, createEventsSource, createSession, getDrafts, getJobs, parseCvWithLlm, startAutopilot, startScan, submitApplication, updateContext, fetchLocalInit, fetchLocalCvBlob, getApplyMemory, optimizeCvForAts, optimizeCvForJob, scoreCvAts, parseCvTimeline, generateCareerGoals, generateLatexCv, startWorkflow, fetchUserData, fetchJobStats, fetchTrackedJobs, updateJobStatus, type ApplyMemory, type AtsOptimizeResult, type CvTimeline, type LatexCvResult, type ApplyRecord, type DraftApplication, type JobItem, type RankedJob, type UserData, type TrackedJob, type JobStats } from "./lib/api";
import { extractTextFromFile } from "./lib/fileText";
import { CvTimelineChart } from "./components/CvTimelineChart";
import { CvChatbot } from "./components/CvChatbot";
import { CvVisualizer } from "./components/CvVisualizer";
import { JobTrackerViz } from "./components/JobTrackerViz";

type ProviderName = "openai" | "anthropic" | "gemini" | "openrouter";

interface FeedEvent {
  id: string;
  text: string;
}

type StepStatus = "pending" | "active" | "done" | "running" | "error";
type StepId = "context" | "scan" | "rank" | "draft" | "done";

interface AgentStep {
  id: StepId;
  label: string;
  status: StepStatus;
  detail?: string;
}

const providers: ProviderName[] = ["openai", "anthropic", "gemini", "openrouter"];
const stepOrder: StepId[] = ["context", "scan", "rank", "draft", "done"];

// Base URL for all API and asset links — empty string on Vercel (same-origin), localhost fallback for dev
const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8787";
const phaseHints: Record<Exclude<StepId, "done">, string[]> = {
  context: [
    "Reading the CV and grounding fields to explicit evidence.",
    "Cleaning profile text before matching.",
    "Checking which details are safe to autofill.",
  ],
  scan: [
    "Searching supported job sources for matching roles.",
    "Removing noisy or duplicate job listings.",
    "Collecting openings that fit your profile.",
  ],
  rank: [
    "Scoring roles against your skills and targets.",
    "Comparing job fit before drafting applications.",
    "Sorting the strongest opportunities first.",
  ],
  draft: [
    "Preparing application packets for shortlisted jobs.",
    "Drafting pitch and cover-letter content.",
    "Marking guarded flows before final submission.",
  ],
};

function makeInitialSteps(): AgentStep[] {
  return [
    { id: "context", label: "Profile context", status: "pending" },
    { id: "scan", label: "Scan sources", status: "pending" },
    { id: "rank", label: "Rank opportunities", status: "pending" },
    { id: "draft", label: "Prepare applications", status: "pending" },
    { id: "done", label: "Cycle completed", status: "pending" },
  ];
}

const SESSION_KEY = "career-ops-sid";

function mergeJobList<T extends { url: string }>(prev: T[], incoming: T[]): T[] {
  const map = new Map(prev.map((j) => [j.url, j]));
  for (const j of incoming) map.set(j.url, j); // newer wins
  return [...map.values()];
}

export default function App() {
  const [sessionId, setSessionId] = useState<string>(
    () => localStorage.getItem(SESSION_KEY) ?? "",
  );
  const [cv, setCv] = useState("");
  const [skills, setSkills] = useState("");   // filled from CV on parse
  const [goals, setGoals] = useState("");
  const [roles, setRoles] = useState("");      // filled from CV on parse
  const [locations, setLocations] = useState(""); // filled from CV on parse
  const [provider, setProvider] = useState<ProviderName>("openai");
  const [apiKey, setApiKey] = useState("");
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [ranked, setRanked] = useState<RankedJob[]>([]);
  const [scanRunCount, setScanRunCount] = useState(0); // jobs found in current run
  const [drafts, setDrafts] = useState<DraftApplication[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [verify, setVerify] = useState(false);
  const [autonomous, setAutonomous] = useState(true);
  const [intervalMinutes, setIntervalMinutes] = useState(5);
  const [maxJobsPerRun, setMaxJobsPerRun] = useState(25);
  const [isParsingCv, setIsParsingCv] = useState(false);
  const [isPreloading, setIsPreloading] = useState(false);
  const [preloadDone, setPreloadDone] = useState(false);
  const [feed, setFeed] = useState<FeedEvent[]>([]);
  const [steps, setSteps] = useState<AgentStep[]>(makeInitialSteps());
  const [activeHintIndex, setActiveHintIndex] = useState(0);

  // Apply queue: draft URLs selected by user for submission
  const [applyQueue, setApplyQueue] = useState<Set<string>>(new Set());
  const [applyRecords, setApplyRecords] = useState<ApplyRecord[]>([]);
  const [isApplying, setIsApplying] = useState(false);
  const [applyMemoryData, setApplyMemoryData] = useState<ApplyMemory | null>(null);
  const [atsScore, setAtsScore] = useState<number | null>(null);
  const [atsIssues, setAtsIssues] = useState<string[]>([]);
  const [isOptimizingCv, setIsOptimizingCv] = useState(false);
  const [atsOptimizeResult, setAtsOptimizeResult] = useState<AtsOptimizeResult | null>(null);

  // Persistent job DB state (survives page refresh, populated from /api/data/*)
  const [jobStats, setJobStats] = useState<JobStats>({ total: 0, shortlisted: 0, applied: 0, rejected: 0, skipped: 0 });
  const [historyJobs, setHistoryJobs] = useState<TrackedJob[]>([]);
  const [showHistoryPanel, setShowHistoryPanel] = useState(false);

  // Tracks which CV text has already been auto-filled so we don't spam the LLM
  const cvAutoFillKey = useRef("");

  // Timeline, goals, per-job ATS, and LaTeX states
  const [timeline, setTimeline] = useState<CvTimeline | null>(null);
  const [isParsingTimeline, setIsParsingTimeline] = useState(false);
  // Per-draft ATS scores: key = jobUrl, value = {score, isLoading, optimizedCv, latexResult}
  const [draftAts, setDraftAts] = useState<Record<string, {
    score: number | null;
    isLoading: boolean;
    isOptimizing: boolean;
    optimizedCv: string | null;
    latexResult: LatexCvResult | null;
    isGeneratingLatex: boolean;
  }>>({});

  // Workflow
  const [isWorkflowRunning, setIsWorkflowRunning] = useState(false);
  const [workflowPhase, setWorkflowPhase] = useState<string>("");
  const [workflowLog, setWorkflowLog] = useState<string[]>([]);
  const [workflowAutoApply, setWorkflowAutoApply] = useState(false);
  const [workflowMaxJobs, setWorkflowMaxJobs] = useState(5);
  const [showWorkflow, setShowWorkflow] = useState(false);

  // Chatbot
  const [showChatbot, setShowChatbot] = useState(false);

  // User data (persistent applications + CV versions)
  const [userData, setUserData] = useState<UserData | null>(null);
  const [showUserData, setShowUserData] = useState(false);

  const activeStep = steps.find((step) => step.status === "active");

  const setPhase = (phase: StepId, detail: string) => {
    setSteps((prev) => {
      const targetIndex = stepOrder.indexOf(phase);
      return prev.map((step, index) => {
        if (index < targetIndex) {
          return { ...step, status: "done" };
        }
        if (index > targetIndex) {
          if (phase === "done") {
            return { ...step, status: "done" };
          }
          return step;
        }
        return {
          ...step,
          status: phase === "done" ? "done" : "active",
          detail,
        };
      });
    });
  };

  useEffect(() => {
    let cancelled = false;
    async function connect(attempt = 0) {
      try {
        // Reuse existing session if still valid
        if (sessionId) {
          try {
            const res = await fetch(`${API_BASE}/api/session/${sessionId}`);
            if (res.ok) {
              const data = await res.json() as { sessionId: string; jobs?: JobItem[]; rankedJobs?: RankedJob[]; drafts?: DraftApplication[]; applyRecords?: ApplyRecord[] };
              // Restore state from saved session
              if (data.rankedJobs?.length) { setRanked(data.rankedJobs); setJobs(data.rankedJobs); }
              else if (data.jobs?.length) setJobs(data.jobs);
              if (data.drafts?.length) setDrafts(data.drafts);
              if (!cancelled) setSessionId(data.sessionId);
              return;
            }
          } catch { /* fall through to create new */ }
        }
        const session = await createSession();
        if (!cancelled) setSessionId(session.sessionId);
      } catch {
        if (!cancelled) {
          const delay = Math.min(2000 * 2 ** attempt, 30000);
          setTimeout(() => { void connect(attempt + 1); }, delay);
        }
      }
    }
    void connect();
    return () => { cancelled = true; };
  }, []);

  // Auto-load preloaded CV + API key from the local server on first mount
  useEffect(() => {
    async function preload() {
      setIsPreloading(true);
      try {
        const init = await fetchLocalInit();
        if (init?.apiKey) {
          setApiKey(init.apiKey);
          setProvider(init.provider);
        }
        if (init?.hasCv) {
          const blob = await fetchLocalCvBlob();
          if (blob) {
            const file = new File([blob], "startup_v4.pdf", { type: "application/pdf" });
            const text = await extractTextFromFile(file);
            if (text.trim().length > 20) {
              setCv(text);
              setFeed((prev) => [{ id: crypto.randomUUID(), text: "Preloaded CV: startup_v4.pdf" }, ...prev].slice(0, 100));
            }
          }
        }
      } catch { /* silently ignore preload errors */ } finally {
        setIsPreloading(false);
        setPreloadDone(true);
      }
    }
    void preload();

    // Load persistent job stats from the local DB — runs independently from
    // session setup so history is always visible on page load.
    void fetchJobStats().then(setJobStats);
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    const source = createEventsSource(sessionId);

    source.addEventListener("status", (event) => {
      const messageEvent = event as MessageEvent;
      const payload = JSON.parse(messageEvent.data) as { message: string };
      setFeed((prev) => [{ id: crypto.randomUUID(), text: payload.message }, ...prev].slice(0, 100));
    });

    source.addEventListener("phase", (event) => {
      const messageEvent = event as MessageEvent;
      const payload = JSON.parse(messageEvent.data) as { phase: StepId; message: string };
      setPhase(payload.phase, payload.message);
      setFeed((prev) => [{ id: crypto.randomUUID(), text: `Step: ${payload.message}` }, ...prev].slice(0, 100));
      // Refresh persistent job stats whenever a cycle completes so the topbar stays accurate
      if (payload.phase === "done") {
        void fetchJobStats().then(setJobStats);
      }
    });

    source.addEventListener("scan_line", (event) => {
      const messageEvent = event as MessageEvent;
      const payload = JSON.parse(messageEvent.data) as { line: string };
      setFeed((prev) => [{ id: crypto.randomUUID(), text: payload.line }, ...prev].slice(0, 100));
    });

    source.addEventListener("scan_done", () => {
      setIsBusy(false);
      void getJobs(sessionId).then((items) => {
        setJobs((prev) => mergeJobList(prev, items));
        setScanRunCount(items.length);
      });
    });

    source.addEventListener("job_found", (event) => {
      const messageEvent = event as MessageEvent;
      const payload = JSON.parse(messageEvent.data) as { job: JobItem };
      setJobs((prev) => mergeJobList(prev, [payload.job]));
      setScanRunCount((c) => c + 1);
    });

    source.addEventListener("autopilot_ranked", () => {
      void getDrafts(sessionId).then((data) => {
        setRanked((prev) => mergeJobList(prev, data.rankedJobs) as RankedJob[]);
        setDrafts((prev) => {
          const map = new Map(prev.map((d) => [d.jobUrl, d]));
          for (const d of data.drafts) map.set(d.jobUrl, d);
          return [...map.values()];
        });
        setJobs((prev) => mergeJobList(prev, data.rankedJobs));
      });
    });

    // Workflow events
    source.addEventListener("wf_phase", (event) => {
      const e = event as MessageEvent;
      const p = JSON.parse(e.data) as { phase: string; message: string };
      setWorkflowPhase(p.message);
      setWorkflowLog((prev) => [`[${p.phase.toUpperCase()}] ${p.message}`, ...prev].slice(0, 200));
      if (p.phase === "done" || p.phase === "error") setIsWorkflowRunning(false);
    });

    source.addEventListener("wf_progress", (event) => {
      const e = event as MessageEvent;
      const p = JSON.parse(e.data) as { step: string; detail: string };
      setWorkflowLog((prev) => [`  → ${p.detail}`, ...prev].slice(0, 200));
      setFeed((prev) => [{ id: crypto.randomUUID(), text: p.detail }, ...prev].slice(0, 100));
    });

    source.addEventListener("wf_job_ready", (event) => {
      const e = event as MessageEvent;
      const p = JSON.parse(e.data) as { jobUrl: string; company: string; title: string; atsScore: number; latexUrl: string | null; htmlUrl: string | null };
      setDraftAts((prev) => ({
        ...prev,
        [p.jobUrl]: {
          score: p.atsScore,
          isLoading: false, isOptimizing: false,
          optimizedCv: null,
          latexResult: p.htmlUrl ? { texFileName: "", htmlFileName: "", texDownloadUrl: p.latexUrl ?? "", htmlDownloadUrl: p.htmlUrl, latexContent: "" } : null,
          isGeneratingLatex: false,
        },
      }));
      setFeed((prev) => [{ id: crypto.randomUUID(), text: `[${p.company}] ATS ${p.atsScore}/100 · CV ready` }, ...prev].slice(0, 100));
      // Refresh drafts after workflow populates them
      void getDrafts(sessionId).then((data) => {
        setRanked(data.rankedJobs);
        setDrafts(data.drafts);
      });
    });

    source.addEventListener("wf_apply_result", (event) => {
      const e = event as MessageEvent;
      const p = JSON.parse(e.data) as { jobUrl: string; status: "submitted" | "failed" | "unsupported"; message: string };
      setApplyRecords((prev) => {
        const exists = prev.find((r) => r.jobUrl === p.jobUrl);
        if (exists) return prev.map((r) => r.jobUrl === p.jobUrl ? { ...r, status: p.status, message: p.message } : r);
        return [{ jobUrl: p.jobUrl, company: "", title: "", ats: "unknown" as const, status: p.status, message: p.message, submittedAt: Date.now() }, ...prev];
      });
    });

    source.addEventListener("wf_done", (event) => {
      const e = event as MessageEvent;
      const p = JSON.parse(e.data) as { totalJobs: number; submitted: number; failed: number };
      setIsWorkflowRunning(false);
      setWorkflowPhase(`Done — ${p.totalJobs} jobs · ${p.submitted} submitted · ${p.failed} failed`);
      void fetchUserData().then((d) => { if (d) setUserData(d); });
    });

    source.addEventListener("wf_error", (event) => {
      const e = event as MessageEvent;
      const p = JSON.parse(e.data) as { message: string };
      setIsWorkflowRunning(false);
      setWorkflowPhase(`Error: ${p.message}`);
    });

    source.addEventListener("error", (event) => {
      setIsBusy(false);
      const messageEvent = event as MessageEvent;
      let message = "Live stream disconnected; retrying...";
      if (typeof messageEvent.data === "string" && messageEvent.data.length > 0) {
        try {
          message = `Error: ${JSON.parse(messageEvent.data).message}`;
        } catch {
          message = `Error: ${messageEvent.data}`;
        }
      }
      setFeed((prev) => [{ id: crypto.randomUUID(), text: message }, ...prev].slice(0, 100));
    });

    return () => source.close();
  }, [sessionId]);

  useEffect(() => {
    setActiveHintIndex(0);
    if (!isBusy || !activeStep || activeStep.id === "done") {
      return;
    }

    const timer = window.setInterval(() => {
      setActiveHintIndex((current) => current + 1);
    }, 1600);

    return () => window.clearInterval(timer);
  }, [activeStep?.id, isBusy]);

  const canSubmit = useMemo(() => {
    return sessionId.length > 0 && cv.trim().length > 20 && apiKey.trim().length > 10;
  }, [sessionId, cv, apiKey]);

  const activeHint = activeStep && activeStep.id !== "done"
    ? phaseHints[activeStep.id][activeHintIndex % phaseHints[activeStep.id].length]
    : "Waiting to start.";

  async function parseAndApplyCvAutofill() {
    const parsed = await parseCvWithLlm(sessionId, {
      provider,
      apiKey,
      cvText: cv,
    });

    if (parsed.cleanedCv.trim().length > 0) setCv(parsed.cleanedCv);
    // Always overwrite from CV — the CV is the source of truth for these fields
    if (parsed.skills.length > 0) setSkills(parsed.skills.join(", "));
    if (parsed.goals.trim().length > 0 && goals.trim().length < 2) setGoals(parsed.goals);
    if (parsed.preferredRoles.length > 0) setRoles(parsed.preferredRoles.join(", "));
    if (parsed.locations.length > 0) setLocations(parsed.locations.join(", "));

    setFeed((prev) => [{ id: crypto.randomUUID(), text: `CV parsed with ${provider}. ${parsed.summary}` }, ...prev].slice(0, 100));
    return parsed;
  }

  async function runPipeline() {
    if (!canSubmit || !sessionId) return;

    setSteps(makeInitialSteps());
    setIsBusy(true);
    setScanRunCount(0);

    let cvToSend = cv;
    let skillsToSend = skills;
    let goalsToSend = goals;
    let rolesToSend = roles;
    let locationsToSend = locations;

    try {
      // Always parse the CV before running so roles/skills/locations come from
      // the actual uploaded CV, not stale state or a failed previous parse.
      if (skills.trim().length < 2 || goals.trim().length < 2 || roles.trim().length < 2) {
        setFeed((prev) => [{ id: crypto.randomUUID(), text: "Parsing CV to extract roles, skills and goals..." }, ...prev].slice(0, 100));
        const parsed = await parseAndApplyCvAutofill();
        if (parsed.cleanedCv.trim().length > 0) cvToSend = parsed.cleanedCv;
        if (parsed.skills.length > 0) skillsToSend = parsed.skills.join(", ");
        if (parsed.goals.trim().length > 0) goalsToSend = parsed.goals;
        if (parsed.preferredRoles.length > 0) rolesToSend = parsed.preferredRoles.join(", ");
        if (parsed.locations.length > 0) locationsToSend = parsed.locations.join(", ");
      }

      // Fallback: if goals still empty after auto-parse, derive from roles/skills
      if (goalsToSend.trim().length < 2) {
        const rolesPreview = rolesToSend.split(",").slice(0, 2).map((r) => r.trim()).filter(Boolean).join(", ");
        const skillsPreview = skillsToSend.split(",").slice(0, 3).map((s) => s.trim()).filter(Boolean).join(", ");
        goalsToSend = `Seeking ${rolesPreview || "engineering"} roles leveraging ${skillsPreview || "technical skills"}.`;
      }

      // ── ATS CV Optimization: always ensure score ≥ 85 before submitting context ──
      if (apiKey.trim().length >= 12 && cvToSend.trim().length >= 20) {
        try {
          setFeed((prev) => [{ id: crypto.randomUUID(), text: "Checking ATS score..." }, ...prev].slice(0, 100));
          const scoreResult = await scoreCvAts(sessionId, cvToSend, provider, apiKey, rolesToSend.split(",").map((r) => r.trim()).filter(Boolean));
          setAtsScore(scoreResult.score);
          setAtsIssues(scoreResult.issues);

          if (scoreResult.score < 85) {
            setIsOptimizingCv(true);
            setFeed((prev) => [{ id: crypto.randomUUID(), text: `ATS score ${scoreResult.score}/100 — optimizing CV to reach 85+...` }, ...prev].slice(0, 100));
            const optimizeResult = await optimizeCvForAts(
              sessionId,
              cvToSend,
              provider,
              apiKey,
              rolesToSend.split(",").map((r) => r.trim()).filter(Boolean),
            );
            setAtsOptimizeResult(optimizeResult);
            setAtsScore(optimizeResult.optimizedScore);
            if (optimizeResult.wasOptimized && optimizeResult.optimizedCv.length > 50) {
              cvToSend = optimizeResult.optimizedCv;
              setCv(optimizeResult.optimizedCv);
              setFeed((prev) => [{ id: crypto.randomUUID(), text: `CV optimized: ATS score ${optimizeResult.originalScore} → ${optimizeResult.optimizedScore}/100` }, ...prev].slice(0, 100));
            }
          } else {
            setFeed((prev) => [{ id: crypto.randomUUID(), text: `ATS score ${scoreResult.score}/100 ✔ already above 85` }, ...prev].slice(0, 100));
          }
        } catch {
          // ATS optimization is non-blocking — pipeline continues regardless
          setFeed((prev) => [{ id: crypto.randomUUID(), text: "ATS check skipped (will continue with current CV)" }, ...prev].slice(0, 100));
        } finally {
          setIsOptimizingCv(false);
        }
      }

      await updateContext(sessionId, {
        cv: cvToSend,
        skills: skillsToSend,
        goals: goalsToSend,
        preferredRoles: rolesToSend.split(",").map((role) => role.trim()).filter(Boolean),
        locations: locationsToSend.split(",").map((location) => location.trim()).filter(Boolean),
        providers: [{ provider, apiKey }],
      });

      if (autonomous) {
        await configureAutomation(sessionId, {
          enabled: true,
          intervalMinutes,
          maxJobsPerRun,
          autoApplyRequested: true,
        });
        await startAutopilot(sessionId, verify);
        return;
      }

      await startScan(sessionId, verify);
    } catch (error) {
      setIsBusy(false);
      setSteps((prev) => prev.map((s) => (s.status === "running" ? { ...s, status: "error" as const } : s)));
      setFeed((prev) => [{ id: crypto.randomUUID(), text: `Pipeline error: ${error instanceof Error ? error.message : "Unknown error"}` }, ...prev].slice(0, 100));
    }
  }

  async function onUploadCv(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await extractTextFromFile(file);
      if (text.trim().length < 20) {
        throw new Error("Could not extract enough readable text from the file");
      }
      setCv(text);
      setTimeline(null); // reset so useEffect re-triggers
      setFeed((prev) => [{ id: crypto.randomUUID(), text: `Loaded CV file: ${file.name} — parsing timeline & goals...` }, ...prev].slice(0, 100));
      // Auto-generate goals if we have an API key
      if (sessionId && apiKey.trim().length >= 12) {
        generateCareerGoals(sessionId, text, provider, apiKey)
          .then((g) => { if (g && goals.trim().length < 2) setGoals(g); })
          .catch(() => {});
      }
    } catch (error) {
      setFeed((prev) => [{ id: crypto.randomUUID(), text: `CV upload failed: ${error instanceof Error ? error.message : "Unknown error"}` }, ...prev].slice(0, 100));
    }
  }

  async function onParseCvWithLlm() {
    if (!sessionId || cv.trim().length < 20 || apiKey.trim().length < 12) {
      setFeed((prev) => [{ id: crypto.randomUUID(), text: "Provide session, API key, and CV text before parsing." }, ...prev].slice(0, 100));
      return;
    }

    setIsParsingCv(true);
    try {
      await parseAndApplyCvAutofill();
    } catch (error) {
      setFeed((prev) => [{ id: crypto.randomUUID(), text: `CV parse failed: ${error instanceof Error ? error.message : "Unknown error"}` }, ...prev].slice(0, 100));
    } finally {
      setIsParsingCv(false);
    }
  }

  function toggleQueue(jobUrl: string) {
    setApplyQueue((prev) => {
      const next = new Set(prev);
      if (next.has(jobUrl)) {
        next.delete(jobUrl);
      } else {
        next.add(jobUrl);
      }
      return next;
    });
  }

  async function confirmAndApply(jobUrl: string) {
    if (!sessionId) return;
    setIsApplying(true);
    try {
      const record = await submitApplication(sessionId, jobUrl);
      setApplyRecords((prev) => [...prev, record]);
      setApplyQueue((prev) => {
        const next = new Set(prev);
        next.delete(jobUrl);
        return next;
      });
      const msg = record.status === "submitted"
        ? `Applied to ${record.company} – ${record.title} ✓`
        : `Auto-apply result: ${record.message}`;
      setFeed((prev) => [{ id: crypto.randomUUID(), text: msg }, ...prev].slice(0, 100));
    } catch (error) {
      setFeed((prev) => [{ id: crypto.randomUUID(), text: `Apply failed: ${error instanceof Error ? error.message : "Unknown error"}` }, ...prev].slice(0, 100));
    } finally {
      setIsApplying(false);
      void getApplyMemory().then((m) => { if (m) setApplyMemoryData(m); });
    }
  }

  async function submitAllQueued() {
    if (!sessionId || applyQueue.size === 0) return;
    setIsApplying(true);
    try {
      const records = await bulkSubmitApplications(sessionId, [...applyQueue]);
      setApplyRecords((prev) => [...prev, ...records]);
      setApplyQueue(new Set());
      const submitted = records.filter((r) => r.status === "submitted").length;
      setFeed((prev) => [{ id: crypto.randomUUID(), text: `Bulk apply done: ${submitted}/${records.length} submitted.` }, ...prev].slice(0, 100));
    } catch (error) {
      setFeed((prev) => [{ id: crypto.randomUUID(), text: `Bulk apply error: ${error instanceof Error ? error.message : "Unknown error"}` }, ...prev].slice(0, 100));
    } finally {
      setIsApplying(false);
      // Refresh memory graph after applies
      void getApplyMemory().then((m) => { if (m) setApplyMemoryData(m); });
    }
  }

  async function refreshMemory() {
    const m = await getApplyMemory();
    if (m) setApplyMemoryData(m);
  }

  // Auto-fill roles, locations, skills, goals from CV as soon as apiKey is ready.
  // The ref key tracks which CV+provider pair was last parsed to avoid re-runs on keystrokes.
  useEffect(() => {
    if (!sessionId || cv.trim().length < 100 || apiKey.trim().length < 12) return;
    const parseKey = `${cv}::${provider}`;
    if (cvAutoFillKey.current === parseKey) return; // already ran for this CV+provider
    cvAutoFillKey.current = parseKey;

    void parseCvWithLlm(sessionId, { provider, apiKey, cvText: cv })
      .then((parsed) => {
        // Always overwrite — CV is the source of truth for roles, skills, and locations.
        // User can still edit the fields after auto-fill.
        if (parsed.preferredRoles.length > 0) setRoles(parsed.preferredRoles.join(", "));
        if (parsed.locations.length > 0) setLocations(parsed.locations.join(", "));
        if (parsed.skills.length > 0) setSkills(parsed.skills.join(", "));
        if (parsed.goals.trim().length > 0 && goals.trim().length < 2) setGoals(parsed.goals);
        const roleHint = parsed.preferredRoles.length > 0
          ? parsed.preferredRoles.slice(0, 3).join(", ")
          : "no roles extracted — check CV has job titles";
        setFeed((prev) => [{ id: crypto.randomUUID(), text: `CV parsed · Roles: ${roleHint}` }, ...prev].slice(0, 100));
      })
      .catch((err: unknown) => {
        // Reset key so user can retry after fixing their API key
        cvAutoFillKey.current = "";
        const msg = err instanceof Error ? err.message : String(err);
        setFeed((prev) => [{ id: crypto.randomUUID(), text: `CV auto-parse failed: ${msg}` }, ...prev].slice(0, 100));
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cv, apiKey, sessionId, provider]);

  // Auto-generate career goals + parse timeline whenever CV + API key are ready
  useEffect(() => {
    if (!sessionId || cv.trim().length < 100 || apiKey.trim().length < 12) return;
    if (timeline) return; // already parsed

    setIsParsingTimeline(true);
    parseCvTimeline(sessionId, cv, provider, apiKey)
      .then((t) => {
        if (!t) return;
        setTimeline(t);
        // If goals are empty, auto-fill from timeline's careerGoals
        if (t.careerGoals && goals.trim().length < 2) {
          setGoals(t.careerGoals);
          setFeed((prev) => [{ id: crypto.randomUUID(), text: "Career goals auto-generated from CV." }, ...prev].slice(0, 100));
        }
      })
      .catch(() => {/* non-blocking */})
      .finally(() => setIsParsingTimeline(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cv, apiKey, sessionId]);

  // Per-draft helpers
  async function runJobAts(draft: DraftApplication) {
    if (!sessionId || apiKey.trim().length < 12) return;
    setDraftAts((prev) => ({ ...prev, [draft.jobUrl]: { ...(prev[draft.jobUrl] ?? { score: null, optimizedCv: null, latexResult: null, isGeneratingLatex: false, isOptimizing: false }), isLoading: true } }));
    try {
      const result = await optimizeCvForJob(sessionId, cv, provider, apiKey, draft.title, `${draft.company} ${draft.title} ${draft.coverLetter.slice(0, 400)}`);
      setDraftAts((prev) => ({
        ...prev,
        [draft.jobUrl]: {
          ...prev[draft.jobUrl],
          score: result.optimizedScore,
          isLoading: false,
          isOptimizing: false,
          optimizedCv: result.wasOptimized ? result.optimizedCv : null,
          latexResult: null,
          isGeneratingLatex: false,
        },
      }));
      if (result.wasOptimized) {
        setFeed((prev) => [{ id: crypto.randomUUID(), text: `${draft.company}: CV optimized ${result.originalScore}→${result.optimizedScore}/100` }, ...prev].slice(0, 100));
      }
    } catch {
      setDraftAts((prev) => ({ ...prev, [draft.jobUrl]: { ...(prev[draft.jobUrl] ?? { score: null, optimizedCv: null, latexResult: null, isGeneratingLatex: false, isOptimizing: false }), isLoading: false } }));
    }
  }

  async function generateDraftLatex(draft: DraftApplication) {
    if (!sessionId || apiKey.trim().length < 12) return;
    const cvForThisDraft = draftAts[draft.jobUrl]?.optimizedCv ?? cv;
    setDraftAts((prev) => ({ ...prev, [draft.jobUrl]: { ...(prev[draft.jobUrl] ?? { score: null, optimizedCv: null, latexResult: null, isLoading: false, isOptimizing: false }), isGeneratingLatex: true } }));
    try {
      const slug = `${draft.company}-${draft.title}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
      const result = await generateLatexCv(sessionId, cvForThisDraft, provider, apiKey, draft.title, slug);
      setDraftAts((prev) => ({
        ...prev,
        [draft.jobUrl]: { ...prev[draft.jobUrl], latexResult: result, isGeneratingLatex: false },
      }));
      setFeed((prev) => [{ id: crypto.randomUUID(), text: `CV files generated for ${draft.company} — ready to download` }, ...prev].slice(0, 100));
    } catch (e) {
      setDraftAts((prev) => ({ ...prev, [draft.jobUrl]: { ...prev[draft.jobUrl], isGeneratingLatex: false } }));
      setFeed((prev) => [{ id: crypto.randomUUID(), text: `LaTeX generation failed: ${e instanceof Error ? e.message : "Unknown"}` }, ...prev].slice(0, 100));
    }
  }

  // Full autonomous workflow: parse → scan → optimize → apply
  async function startFullWorkflow() {
    if (!sessionId || !cv.trim() || apiKey.trim().length < 12) return;
    setIsWorkflowRunning(true);
    setWorkflowLog([]);
    setWorkflowPhase("Starting…");
    try {
      await startWorkflow(sessionId, cv, provider, apiKey, {
        autoApply: workflowAutoApply,
        maxJobs: workflowMaxJobs,
      });
      setWorkflowPhase("Running — follow the live feed below");
    } catch (e) {
      setWorkflowPhase(`Error: ${e instanceof Error ? e.message : "Unknown"}`);
      setIsWorkflowRunning(false);
    }
  }

  // Fetch saved user data from server
  async function fetchAndShowUserData() {
    const data = await fetchUserData();
    if (data) setUserData(data);
    setShowUserData(true);
  }

  return (
    <div className="page">
      <div className="scanline-overlay" />
      <motion.div className="aurora" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 2 }} />

      {/* ── Top navigation bar ─────────────────────────────────────── */}
      <div className="topbar">
        <div className="topbar-brand">
          <span className="bracket">[</span>
          CAREER<span style={{ color: "var(--cyan)" }}>-OPS</span>
          <span className="bracket">]</span>
          <span style={{ opacity: 0.35, fontSize: "0.65rem", fontWeight: 300 }}>v2</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
          {/* Stats bar */}
          {(jobs.length > 0 || drafts.length > 0 || applyRecords.length > 0 || jobStats.total > 0) && (
            <div style={{ display: "flex", gap: "0.75rem", fontFamily: "var(--mono)", fontSize: "0.7rem", color: "var(--ink-2)" }}>
              {jobs.length > 0 && <span style={{ color: "var(--cyan)" }}>{jobs.length} jobs</span>}
              {drafts.length > 0 && <span style={{ color: "var(--purple)" }}>{drafts.length} drafts</span>}
              {applyRecords.filter(r => r.status === "submitted").length > 0 && (
                <span style={{ color: "var(--green)" }}>
                  {applyRecords.filter(r => r.status === "submitted").length} applied
                </span>
              )}
              {applyRecords.filter(r => r.status === "failed").length > 0 && (
                <span style={{ color: "var(--red)" }}>
                  {applyRecords.filter(r => r.status === "failed").length} failed
                </span>
              )}
              {/* Persistent DB counts from disk — always accurate across restarts */}
              {jobStats.applied > 0 && (
                <span style={{ color: "var(--green)", borderLeft: "1px solid var(--border)", paddingLeft: "0.75rem" }}>
                  DB: {jobStats.applied} applied
                </span>
              )}
              {jobStats.total > 0 && (
                <button
                  onClick={() => {
                    void fetchTrackedJobs().then(jobs => {
                      setHistoryJobs(jobs);
                      setShowHistoryPanel(true);
                    });
                  }}
                  style={{ background: "none", border: "1px solid var(--border)", color: "var(--ink-2)", padding: "0.15rem 0.5rem", fontSize: "0.65rem", fontFamily: "var(--mono)", cursor: "pointer", borderRadius: "3px" }}
                >
                  {jobStats.total} seen ↗
                </button>
              )}
              {autonomous && isBusy && (
                <span style={{ color: "var(--amber)", animation: "pulse 1.4s ease-in-out infinite" }}>⚡ AUTOPILOT</span>
              )}
            </div>
          )}
          <div className="topbar-status">
            <div className={`status-dot${isBusy ? " status-busy" : ""}`} />
            {sessionId ? `SESSION ${sessionId.slice(0, 8).toUpperCase()}` : "CONNECTING..."}
          </div>
        </div>
      </div>

      <main className="layout">
        <header>
          <p className="kicker">AI-Powered · Zero-Spray · Session-Only</p>
          <h1>
            <span className="accent-green">HACK</span> YOUR{" "}
            <span className="accent-cyan">JOB SEARCH</span>
          </h1>
          <p className="sub">
            {'>'} parse CV → scan 40+ portals → optimize ATS per-job → auto-apply
          </p>
          {isPreloading && (
            <p className="sub" style={{ color: "var(--purple)" }}>{'>'} loading credentials from local config...</p>
          )}
          {preloadDone && cv.length > 20 && (
            <p className="sub" style={{ color: "var(--green)" }}>{'>'} CV loaded · system armed · ready to fire</p>
          )}

          {/* Action bar */}
          <div className="action-bar">
            <button type="button" className={`pill pill-green${showWorkflow ? " active" : ""}`}
              onClick={() => setShowWorkflow((v) => !v)}>
              ⚡ FULL AUTO WORKFLOW
            </button>
            <button type="button" className={`pill pill-cyan${showChatbot ? " active" : ""}`}
              onClick={() => setShowChatbot((v) => !v)}>
              ◈ CV ASSISTANT
            </button>
            <button type="button" className={`pill pill-amber${showUserData ? " active" : ""}`}
              onClick={() => void fetchAndShowUserData()}>
              ▸ MY APPLICATIONS
            </button>
            {cv.trim().length > 20 && (
              <button type="button" className="pill pill-purple"
                onClick={() => setShowUserData((v) => !v)}>
                ⬡ VISUALIZE CV
              </button>
            )}
          </div>
        </header>

        <section className="grid">
          <motion.section className="panel form" initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }}>
            <label>CV</label>
            <textarea value={cv} onChange={(event) => setCv(event.target.value)} placeholder="Paste your CV markdown here..." />
            <label>Upload CV file (.pdf/.txt/.md/.csv/.log)</label>
            <input type="file" accept=".pdf,.txt,.md,.csv,.log,.text,application/pdf" onChange={(event) => void onUploadCv(event)} />

            <label>Core Skills <span style={{ fontFamily: "var(--mono)", fontSize: "0.68rem", color: "var(--cyan)", fontWeight: 400 }}>{skills ? "" : "(auto-filled from CV when API key is ready)"}</span></label>
            <textarea value={skills} onChange={(event) => setSkills(event.target.value)} placeholder="Auto-extracted from CV — paste your CV and add an API key above..." />

            <label>Career Goals</label>
            <textarea value={goals} onChange={(event) => setGoals(event.target.value)} placeholder="I want a senior applied AI role in a product company..." />

            <div className="row">
              <div>
                <label>Preferred Roles <span style={{ fontFamily: "var(--mono)", fontSize: "0.68rem", color: "var(--purple)", fontWeight: 400 }}>{roles ? "" : "(auto-filled from CV)"}</span></label>
                <input value={roles} onChange={(event) => setRoles(event.target.value)} placeholder="Auto-extracted from CV..." />
              </div>
              <div>
                <label>Locations <span style={{ fontFamily: "var(--mono)", fontSize: "0.68rem", color: "var(--cyan)", fontWeight: 400 }}>{locations ? "" : "(auto-filled from CV)"}</span></label>
                <input value={locations} onChange={(event) => setLocations(event.target.value)} placeholder="Auto-extracted from CV..." />
              </div>
            </div>

            <div className="row">
              <div>
                <label>AI Provider</label>
                <select value={provider} onChange={(event) => setProvider(event.target.value as ProviderName)}>
                  {providers.map((item) => <option key={item}>{item}</option>)}
                </select>
              </div>
              <div>
                <label>API Key (session only)</label>
                <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
              </div>
            </div>

            <label className="checkbox">
              <input type="checkbox" checked={verify} onChange={(event) => setVerify(event.target.checked)} />
              Verify links with Playwright (slower, cleaner results)
            </label>

            <label className="checkbox">
              <input type="checkbox" checked={autonomous} onChange={(event) => setAutonomous(event.target.checked)} />
              Autonomous mode (scan, rank, and prepare application packets automatically)
            </label>
            {autonomous && (
              <div style={{
                fontFamily: "var(--mono)", fontSize: "0.72rem", padding: "0.5rem 0.75rem",
                borderLeft: "2px solid var(--amber)", color: "var(--amber)", background: "rgba(255,170,0,0.04)",
                borderRadius: "0 var(--radius) var(--radius) 0",
              }}>
                ⚡ Autopilot will scan every {intervalMinutes}m · max {maxJobsPerRun} jobs/run · results accumulate (no reset)
              </div>
            )}

            <div className="row">
              <div>
                <label>Autopilot interval (minutes)</label>
                <input type="number" min={2} max={240} value={intervalMinutes} onChange={(event) => setIntervalMinutes(Number(event.target.value || 5))} />
              </div>
              <div>
                <label>Max jobs per run</label>
                <input type="number" min={1} max={100} value={maxJobsPerRun} onChange={(event) => setMaxJobsPerRun(Number(event.target.value || 25))} />
              </div>
            </div>

            <button type="button" disabled={isParsingCv || cv.trim().length < 20 || apiKey.trim().length < 12} onClick={() => void onParseCvWithLlm()}>
              {isParsingCv ? "Parsing CV..." : "Parse CV with LLM and Auto-Fill"}
            </button>

            <button
              type="button"
              disabled={isOptimizingCv || cv.trim().length < 20 || apiKey.trim().length < 12 || !sessionId}
              onClick={() => void (async () => {
                if (!sessionId) return;
                setIsOptimizingCv(true);
                setFeed((prev) => [{ id: crypto.randomUUID(), text: "Optimizing CV for ATS score 85+..." }, ...prev].slice(0, 100));
                try {
                  const result = await optimizeCvForAts(
                    sessionId,
                    cv,
                    provider,
                    apiKey,
                    roles.split(",").map((r) => r.trim()).filter(Boolean),
                  );
                  setAtsOptimizeResult(result);
                  setAtsScore(result.optimizedScore);
                  setAtsIssues(result.issues);
                  if (result.wasOptimized && result.optimizedCv.length > 50) {
                    setCv(result.optimizedCv);
                    setFeed((prev) => [{ id: crypto.randomUUID(), text: `CV optimized: ATS ${result.originalScore} → ${result.optimizedScore}/100 (+${result.keywordsAdded.length} keywords)` }, ...prev].slice(0, 100));
                  } else {
                    setFeed((prev) => [{ id: crypto.randomUUID(), text: `CV already strong: ATS ${result.originalScore}/100` }, ...prev].slice(0, 100));
                  }
                } catch (err) {
                  setFeed((prev) => [{ id: crypto.randomUUID(), text: `Optimization failed: ${err instanceof Error ? err.message : "Unknown"}` }, ...prev].slice(0, 100));
                } finally {
                  setIsOptimizingCv(false);
                }
              })()}
              style={{
                background: "transparent",
                border: `1px solid ${isOptimizingCv ? "var(--cyan)" : atsScore !== null && atsScore < 85 ? "var(--red)" : "var(--green)"}`,
                color: isOptimizingCv ? "var(--cyan)" : atsScore !== null && atsScore < 85 ? "var(--red)" : "var(--green)",
                display: "flex", alignItems: "center", gap: "0.5rem", justifyContent: "center",
              }}
            >
              {isOptimizingCv ? "Optimizing CV..." : "Optimize CV for ATS (85+ Score)"}
              {atsScore !== null && !isOptimizingCv && (
                <span className={`chip ${atsScore >= 85 ? "chip-green" : atsScore >= 70 ? "chip-amber" : "chip-red"}`}>
                  {atsScore}/100
                </span>
              )}
            </button>

            {atsIssues.length > 0 && (
              <details style={{ fontFamily: "var(--mono)", fontSize: "0.75rem", marginTop: "-0.25rem" }}>
                <summary style={{ cursor: "pointer", color: "var(--amber)" }}>ATS issues found ({atsIssues.length}) ▾</summary>
                <ul style={{ margin: "0.25rem 0 0 1rem", color: "var(--red)" }}>
                  {atsIssues.map((issue, i) => <li key={i}>{issue}</li>)}
                </ul>
              </details>
            )}

            {atsOptimizeResult?.wasOptimized && (
              <p style={{ fontFamily: "var(--mono)", fontSize: "0.72rem", color: "var(--green)", marginTop: "-0.25rem" }}>
                + keywords: {atsOptimizeResult.keywordsAdded.slice(0, 6).join(", ")}{atsOptimizeResult.keywordsAdded.length > 6 ? ` +${atsOptimizeResult.keywordsAdded.length - 6} more` : ""}
              </p>
            )}

            <button disabled={!canSubmit || isBusy} onClick={() => void runPipeline()}
              style={{ background: isBusy ? "rgba(0,255,136,0.05)" : "linear-gradient(135deg, rgba(0,255,136,0.18), rgba(0,212,255,0.12))", boxShadow: isBusy ? "none" : "var(--glow-green)" }}>
              {isBusy ? (isOptimizingCv ? "▸ OPTIMIZING CV..." : "▸ AGENT RUNNING...") : autonomous ? "▸ LAUNCH AUTONOMOUS AGENT" : "▸ START LIVE SCAN"}
            </button>
            <p className="empty">Final external submit is guarded. Agent builds apply-ready drafts and rankings automatically.</p>
          </motion.section>

          <motion.section className="panel" initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.1 }}>
            <h2>Agent Pipeline</h2>
            <div className="step-list">
              {steps.map((step) => (
                <div key={step.id} className={`step-item ${step.status}`}>
                  <div className="step-dot" />
                  <div>
                    <p className="step-label">{step.label}</p>
                    <p className="step-detail">{step.detail || "Waiting"}</p>
                  </div>
                </div>
              ))}
            </div>
            <AnimatePresence mode="wait">
              <motion.div
                key={`${activeStep?.id || "idle"}-${activeHintIndex}`}
                className={`step-popover ${activeStep?.status === "active" ? "active" : "idle"}`}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.25 }}
              >
                {activeHint}
              </motion.div>
            </AnimatePresence>
            <h2>Live Feed</h2>
            <div className="feed">
              <AnimatePresence initial={false}>
                {feed.length === 0 && <p style={{ opacity: 0.35 }}>Awaiting agent events...</p>}
                {feed.map((item) => (
                  <motion.p key={item.id} initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
                    {item.text}
                  </motion.p>
                ))}
              </AnimatePresence>
            </div>
          </motion.section>
        </section>

        {/* ── CV Intelligence Panel ────────────────────────────────────── */}
        {cv.trim().length > 20 && (
          <section className="panel jobs">
            <h2>CV Intelligence</h2>
            <CvVisualizer
              cv={cv}
              skills={skills}
              atsScore={atsScore}
              timeline={timeline}
              preferredRoles={roles}
              locations={locations}
            />
          </section>
        )}

        {/* ── Job Intelligence ─────────────────────────────────────────── */}
        {(jobs.length > 0 || applyRecords.length > 0) && (
          <section className="panel jobs">
            <h2>Job Pipeline Intelligence</h2>
            <JobTrackerViz
              applyRecords={applyRecords}
              jobs={jobs.map((j) => ({ url: j.url, title: j.title, company: j.company, location: j.location }))}
              atsScores={Object.fromEntries(
                Object.entries(draftAts).map(([url, v]) => [url, { score: v.score }])
              )}
            />
          </section>
        )}

        <section className="panel jobs">
          <h2 style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
            Shortlisted Jobs
            <span style={{ fontFamily: "var(--mono)", fontSize: "0.75rem", color: "var(--ink-2)", fontWeight: 400 }}>
              {jobs.length} total
              {scanRunCount > 0 && ` · +${scanRunCount} this run`}
            </span>
            {jobs.length > 0 && (
              <button
                type="button"
                onClick={() => { setJobs([]); setRanked([]); setScanRunCount(0); }}
                style={{ width: "auto", fontSize: "0.68rem", padding: "2px 10px",
                  border: "1px solid var(--line)", color: "var(--ink-2)", background: "transparent", marginLeft: "auto" }}
              >
                Clear all
              </button>
            )}
          </h2>
          <div className="cards">
            {(ranked.length > 0 ? ranked : jobs).map((job) => {
              const rj = job as RankedJob;
              const score = rj.score;
              const reasons = rj.reasons;
              return (
                <article key={`${job.url}-${job.title}`}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "0.5rem" }}>
                    <p style={{ fontFamily: "var(--mono)", fontSize: "0.72rem", color: "var(--cyan)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{job.company}</p>
                    {score !== undefined && (
                      <span className={`chip ${score >= 70 ? "chip-green" : score >= 40 ? "chip-amber" : "chip-red"}`}
                        style={{ fontSize: "0.68rem", flexShrink: 0 }}>
                        ★ {score}
                      </span>
                    )}
                  </div>
                  <h3>{job.title}</h3>
                  <p style={{ fontFamily: "var(--mono)", fontSize: "0.73rem", color: "var(--ink-2)" }}>{job.location}</p>
                  {reasons?.length > 0 && (
                    <p style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap", marginTop: "0.25rem" }}>
                      {reasons.slice(0, 3).map((r, i) => (
                        <span key={i} style={{ fontFamily: "var(--mono)", fontSize: "0.65rem", color: "var(--green)", opacity: 0.75 }}>#{r.replace(/^[^:]+:\s*/i, "")}</span>
                      ))}
                    </p>
                  )}
                  <a href={job.url} target="_blank" rel="noreferrer">Open →</a>
                </article>
              );
            })}
            {jobs.length === 0 && <p className="empty">No jobs yet — start the agent to stream results here. Jobs accumulate across runs.</p>}
          </div>
        </section>

        <section className="panel jobs">
          <h2>Application Drafts ({drafts.length})</h2>
          <div className="cards">
            {drafts.map((draft) => {
              const queued = applyQueue.has(draft.jobUrl);
              const applyResult = applyRecords.find((r) => r.jobUrl === draft.jobUrl);
              const draftState = draftAts[draft.jobUrl];
              const atsJobScore = draftState?.score ?? null;
              return (
                <article key={`${draft.jobUrl}-${draft.title}`} style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  <p style={{ fontFamily: "var(--mono)", fontSize: "0.72rem", color: "var(--cyan)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{draft.company}</p>
                  <h3>{draft.title}</h3>
                  <p style={{ fontFamily: "var(--mono)", fontSize: "0.75rem", color: "var(--ink-2)" }}>{draft.note}</p>
                  <p style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                    <span className={`chip ${draft.status === "prepared" ? "chip-green" : "chip-cyan"}`}>
                      {draft.status}
                    </span>
                    {atsJobScore !== null && (
                      <span className={`chip ${atsJobScore >= 85 ? "chip-green" : atsJobScore >= 70 ? "chip-amber" : "chip-red"}`}>
                        ATS {atsJobScore}/100
                      </span>
                    )}
                    {draftState?.isLoading && (
                      <span style={{ fontFamily: "var(--mono)", fontSize: "0.72rem", color: "var(--cyan)" }}>scoring...</span>
                    )}
                  </p>

                  {draft.shortPitch && (
                    <details>
                      <summary style={{ cursor: "pointer", fontFamily: "var(--mono)", fontSize: "0.75rem", color: "var(--ink-2)" }}>short pitch ▾</summary>
                      <p style={{ fontFamily: "var(--mono)", fontSize: "0.75rem", marginTop: "0.5rem", whiteSpace: "pre-wrap", color: "var(--fg)" }}>{draft.shortPitch}</p>
                    </details>
                  )}
                  {draft.coverLetter && (
                    <details>
                      <summary style={{ cursor: "pointer", fontFamily: "var(--mono)", fontSize: "0.75rem", color: "var(--ink-2)" }}>cover letter ▾</summary>
                      <p style={{ fontFamily: "var(--mono)", fontSize: "0.75rem", marginTop: "0.5rem", whiteSpace: "pre-wrap", color: "var(--fg)" }}>{draft.coverLetter}</p>
                    </details>
                  )}
                  {draftState?.optimizedCv && (
                    <details>
                      <summary style={{ cursor: "pointer", fontFamily: "var(--mono)", fontSize: "0.72rem", color: "var(--green)" }}>optimized CV for this job ✓ ▾</summary>
                      <pre style={{ fontFamily: "var(--mono)", fontSize: "0.65rem", marginTop: "0.25rem", maxHeight: "180px", overflowY: "auto", whiteSpace: "pre-wrap", color: "var(--green)", opacity: 0.8 }}>{draftState.optimizedCv.slice(0, 800)}...</pre>
                    </details>
                  )}

                  {/* LaTeX / PDF download links */}
                  {draftState?.latexResult && (
                    <div style={{ display: "flex", gap: "0.5rem", fontSize: "0.75rem", flexWrap: "wrap" }}>
                      <a
                        href={`${API_BASE}${draftState.latexResult.htmlDownloadUrl}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{ width: "auto", padding: "2px 10px", display: "inline-block",
                          border: "1px solid var(--green)", color: "var(--green)", textDecoration: "none", borderRadius: "var(--radius)", fontFamily: "var(--mono)", fontSize: "0.72rem" }}
                      >
                        🖨 Open HTML (Print→PDF)
                      </a>
                      <a
                        href={`${API_BASE}${draftState.latexResult.texDownloadUrl}`}
                        download
                        style={{ width: "auto", padding: "2px 10px", display: "inline-block",
                          border: "1px solid var(--purple)", color: "var(--purple)", textDecoration: "none", borderRadius: "var(--radius)", fontFamily: "var(--mono)", fontSize: "0.72rem" }}
                      >
                        📄 Download .tex (Overleaf)
                      </a>
                    </div>
                  )}

                  {/* Action row */}
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", marginTop: "0.25rem" }}>
                    <a href={draft.jobUrl} target="_blank" rel="noreferrer" style={{ fontSize: "0.8rem" }}>Review →</a>

                    {/* Score & optimize CV for this specific job */}
                    <button
                      type="button"
                      disabled={draftState?.isLoading || apiKey.trim().length < 12}
                      onClick={() => void runJobAts(draft)}
                      style={{ width: "auto", fontSize: "0.7rem", padding: "2px 12px" }}
                    >
                      {draftState?.isLoading ? "Scoring..." : atsJobScore !== null ? "Re-score ATS" : "Score ATS"}
                    </button>

                    {/* Generate LaTeX + HTML CV for this job */}
                    <button
                      type="button"
                      disabled={draftState?.isGeneratingLatex || apiKey.trim().length < 12}
                      onClick={() => void generateDraftLatex(draft)}
                      style={{ width: "auto", fontSize: "0.7rem", padding: "2px 12px",
                        border: "1px solid var(--purple)", color: "var(--purple)", background: "transparent" }}
                    >
                      {draftState?.isGeneratingLatex ? "Generating..." : draftState?.latexResult ? "Regen CV" : "Generate CV"}
                    </button>

                    {/* Apply button — shown after ATS check or LaTeX generated */}
                    {!applyResult && (
                      <>
                        <button
                          type="button"
                          onClick={() => toggleQueue(draft.jobUrl)}
                          style={{ width: "auto", fontSize: "0.7rem", padding: "2px 12px",
                            border: `1px solid ${queued ? "var(--purple)" : "var(--line)"}`,
                            color: queued ? "var(--purple)" : "var(--ink-2)", background: "transparent" }}
                        >
                          {queued ? "✓ Queued" : "Queue"}
                        </button>
                        <button
                          type="button"
                          disabled={isApplying}
                          onClick={() => void confirmAndApply(draft.jobUrl)}
                          style={{ width: "auto", fontSize: "0.7rem", padding: "2px 12px",
                            border: "1px solid var(--green)", color: "var(--green)", background: "rgba(0,255,136,0.05)", fontWeight: 700 }}
                        >
                          {isApplying ? "🌐 Browser applying…" : "Apply Now"}
                        </button>
                      </>
                    )}
                    {applyResult && (
                      <span
                        className={`chip ${applyResult.status === "submitted" ? "chip-green" : applyResult.status === "unsupported" ? "chip-cyan" : "chip-red"}`}
                        title={applyResult.message}
                      >
                        {applyResult.status === "submitted"
                          ? `✓ Applied${applyResult.message.includes("browser") ? " (browser)" : ""}`
                          : applyResult.status === "unsupported"
                          ? "↗ Apply manually"
                          : "✗ Failed — check live feed"}
                      </span>
                    )}
                  </div>
                </article>
              );
            })}
            {drafts.length === 0 && <p className="empty">No drafts yet — run autonomous mode to generate them.</p>}
          </div>
        </section>

        {/* Apply Queue panel */}
        <section className="panel jobs">
          <h2 style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
            Apply Queue ({applyQueue.size})
            {applyQueue.size > 0 && (
              <button
                type="button"
                disabled={isApplying}
                onClick={() => void submitAllQueued()}
                style={{ width: "auto", fontSize: "0.75rem", padding: "4px 18px",
                  boxShadow: isApplying ? "none" : "var(--glow-green)" }}
              >
                {isApplying ? "Submitting..." : `Submit All (${applyQueue.size})`}
              </button>
            )}
          </h2>
          <p style={{ fontFamily: "var(--mono)", fontSize: "0.73rem", color: "var(--ink-2)", marginBottom: "0.75rem", marginTop: 0 }}>
            {'>'} Greenhouse/Lever: direct API submit with CV + cover letter. Ashby and others: direct link.
          </p>
          <div className="cards">
            {[...applyQueue].map((jobUrl) => {
              const draft = drafts.find((d) => d.jobUrl === jobUrl);
              if (!draft) return null;
              return (
                <article key={jobUrl} style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  <p style={{ fontFamily: "var(--mono)", fontSize: "0.72rem", color: "var(--cyan)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{draft.company}</p>
                  <h3>{draft.title}</h3>
                  {draft.coverLetter && (
                    <details>
                      <summary style={{ cursor: "pointer", fontFamily: "var(--mono)", fontSize: "0.75rem", color: "var(--ink-2)" }}>cover letter ▾</summary>
                      <p style={{ fontFamily: "var(--mono)", fontSize: "0.75rem", marginTop: "0.5rem", whiteSpace: "pre-wrap" }}>{draft.coverLetter}</p>
                    </details>
                  )}
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    <button
                      type="button"
                      disabled={isApplying}
                      onClick={() => void confirmAndApply(jobUrl)}
                      style={{ width: "auto", fontSize: "0.75rem", padding: "4px 18px",
                        border: "1px solid var(--green)", color: "var(--green)", background: "rgba(0,255,136,0.05)", fontWeight: 700,
                        boxShadow: isApplying ? "none" : "var(--glow-green)" }}
                    >
                      {isApplying ? "Submitting..." : "Confirm & Submit"}
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleQueue(jobUrl)}
                      style={{ width: "auto", fontSize: "0.75rem", padding: "4px 14px",
                        border: "1px solid var(--line)", color: "var(--ink-2)", background: "transparent" }}
                    >
                      Remove
                    </button>
                  </div>
                </article>
              );
            })}
            {applyQueue.size === 0 && (
              <p className="empty">No applications queued. Click &quot;+ Auto-Apply Queue&quot; on any draft above.</p>
            )}
          </div>
        </section>

        {/* Apply Results */}
        {applyRecords.length > 0 && (
          <section className="panel jobs">
            <h2 style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
              Apply Results
              <span className="chip chip-green">{applyRecords.filter(r => r.status === "submitted").length} ✓</span>
              {applyRecords.filter(r => r.status === "failed").length > 0 && (
                <span className="chip chip-red">{applyRecords.filter(r => r.status === "failed").length} ✗</span>
              )}
            </h2>
            <div className="cards">
              {applyRecords.map((r) => (
                <article key={`${r.jobUrl}-${r.submittedAt}`} style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                  <p style={{ fontFamily: "var(--mono)", fontSize: "0.72rem", color: "var(--cyan)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{r.company}</p>
                  <h3>{r.title}</h3>
                  <p style={{ fontFamily: "var(--mono)", fontSize: "0.72rem", color: "var(--ink-2)" }}>
                    {r.ats.toUpperCase()} · {new Date(r.submittedAt).toLocaleTimeString()}
                  </p>
                  <p style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                    <span className={`chip ${r.status === "submitted" ? "chip-green" : r.status === "unsupported" ? "chip-cyan" : "chip-red"}`}>
                      {r.status === "submitted" ? "✓ applied" : r.status === "unsupported" ? "↗ manual" : "✗ failed"}
                    </span>
                    {r.message.includes("browser") && (
                      <span className="chip chip-purple" style={{ fontSize: "0.65rem" }}>🌐 browser</span>
                    )}
                  </p>
                  <p style={{ fontFamily: "var(--mono)", fontSize: "0.72rem", color: "var(--ink-2)", wordBreak: "break-word" }}>{r.message.slice(0, 160)}{r.message.length > 160 ? "…" : ""}</p>
                  {r.status !== "submitted" && (
                    <a href={r.jobUrl} target="_blank" rel="noreferrer" style={{ fontFamily: "var(--mono)", fontSize: "0.75rem", color: "var(--cyan)" }}>apply manually →</a>
                  )}
                </article>
              ))}
            </div>
          </section>
        )}

        {/* Knowledge Base — memory graph */}
        <section className="panel jobs">
          <h2 style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
            Agent Memory
            <button
              type="button"
              onClick={() => void refreshMemory()}
              style={{ width: "auto", fontSize: "0.7rem", padding: "2px 14px" }}
            >
              REFRESH
            </button>
          </h2>
          <p style={{ fontFamily: "var(--mono)", fontSize: "0.73rem", color: "var(--ink-2)", marginBottom: "0.75rem", marginTop: 0, lineHeight: 1.6 }}>
            {'>'} Agent learns from every apply attempt. ATS field patterns and lessons persist across sessions.
          </p>
          {!applyMemoryData || Object.keys(applyMemoryData.ats).length === 0 ? (
            <p className="empty">No knowledge recorded yet — memory accumulates as you apply.</p>
          ) : (
            <div className="cards">
              {Object.entries(applyMemoryData.ats).map(([atsKey, entry]) => {
                const rate = entry.attempts > 0 ? Math.round((entry.successes / entry.attempts) * 100) : 0;
                return (
                  <article key={atsKey} style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                    <p style={{ fontFamily: "var(--mono)", fontWeight: 700, fontSize: "0.85rem", textTransform: "uppercase", color: "var(--purple)", letterSpacing: "0.1em" }}>
                      {atsKey}
                    </p>
                    <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", fontFamily: "var(--mono)", fontSize: "0.75rem" }}>
                      <span style={{ color: "var(--ink-2)" }}>ATT: <strong style={{ color: "var(--fg)" }}>{entry.attempts}</strong></span>
                      <span style={{ color: "var(--ink-2)" }}>OK: <strong style={{ color: "var(--green)" }}>{entry.successes}</strong></span>
                      <span style={{ color: "var(--ink-2)" }}>RATE: <strong style={{ color: rate > 60 ? "var(--green)" : rate > 30 ? "var(--amber)" : "var(--red)" }}>{rate}%</strong></span>
                    </div>
                    <p style={{ fontFamily: "var(--mono)", fontSize: "0.72rem", color: "var(--ink-2)" }}>strat: {entry.strategy}</p>
                    {entry.lastError && (
                      <details>
                        <summary style={{ cursor: "pointer", fontFamily: "var(--mono)", fontSize: "0.72rem", color: "var(--red)" }}>last error ▾</summary>
                        <p style={{ fontFamily: "var(--mono)", fontSize: "0.72rem", color: "var(--ink-2)", marginTop: "0.25rem", whiteSpace: "pre-wrap" }}>{entry.lastError}</p>
                      </details>
                    )}
                    {entry.learnedLessons.length > 0 && (
                      <div>
                        <p style={{ fontFamily: "var(--mono)", fontSize: "0.72rem", color: "var(--amber)", marginBottom: "0.25rem" }}>lessons:</p>
                        <ul style={{ margin: 0, paddingLeft: "1.25rem", fontFamily: "var(--mono)", fontSize: "0.72rem", color: "var(--ink-2)" }}>
                          {entry.learnedLessons.map((lesson, i) => (
                            <li key={i} style={{ marginBottom: "0.2rem" }}>{lesson}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {Object.keys(entry.requiredExtraFields).length > 0 && (
                      <details>
                        <summary style={{ cursor: "pointer", fontFamily: "var(--mono)", fontSize: "0.72rem", color: "var(--cyan)" }}>required fields ▾</summary>
                        <pre style={{ fontFamily: "var(--mono)", fontSize: "0.7rem", marginTop: "0.25rem", overflowX: "auto", color: "var(--cyan)" }}>
                          {JSON.stringify(entry.requiredExtraFields, null, 2)}
                        </pre>
                      </details>
                    )}
                  </article>
                );
              })}
            </div>
          )}
          {applyMemoryData && Object.keys(applyMemoryData.jobs).length > 0 && (
            <details style={{ marginTop: "1rem" }}>
              <summary style={{ cursor: "pointer", fontFamily: "var(--mono)", fontSize: "0.75rem", color: "var(--cyan)" }}>
                job history ({Object.keys(applyMemoryData.jobs).length} URLs tracked) ▾
              </summary>
              <div style={{ marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                {Object.entries(applyMemoryData.jobs).slice(-20).reverse().map(([url, job]) => (
                  <div key={url} style={{ fontFamily: "var(--mono)", fontSize: "0.72rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
                    <span className={`chip ${job.status === "submitted" ? "chip-green" : job.status === "unsupported" ? "chip-cyan" : "chip-red"}`}>
                      {job.status}
                    </span>
                    <span style={{ color: "var(--ink-2)" }}>{job.ats}</span>
                    <a href={url} target="_blank" rel="noreferrer" style={{ color: "var(--ink-2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{url}</a>
                  </div>
                ))}
              </div>
            </details>
          )}
        </section>

        <section className="panel jobs">
          <h2>Autopilot Ranking ({ranked.length})</h2>
          <div className="cards">
            {ranked.map((item) => (
              <article key={`${item.url}-${item.title}-rank`}>
                <p style={{ fontFamily: "var(--mono)", fontSize: "0.72rem", color: "var(--cyan)", textTransform: "uppercase" }}>{item.company}</p>
                <h3>{item.title}</h3>
                <p>Score: {item.score}/100</p>
                <p>{item.reasons.slice(0, 2).join(" | ") || "Context-based ranking"}</p>
              </article>
            ))}
            {ranked.length === 0 && <p className="empty">No ranking yet. Run autonomous mode first.</p>}
          </div>
        </section>

        {/* ── Career Timeline ───────────────────────────────────────────── */}
        {(timeline || isParsingTimeline) && (
          <section className="panel jobs">
            <h2>
              Career Timeline
              {isParsingTimeline && <span style={{ fontFamily: "var(--mono)", fontSize: "0.72rem", color: "var(--purple)", marginLeft: "0.75rem" }}>parsing...</span>}
              {timeline && <span style={{ fontFamily: "var(--mono)", fontSize: "0.72rem", color: "var(--ink-2)", marginLeft: "0.75rem" }}>{timeline.totalYearsExperience}y · {timeline.experience.length} roles · {timeline.education.length} degrees</span>}
            </h2>
            {timeline && <CvTimelineChart timeline={timeline} />}
          </section>
        )}

        {/* ── Full Auto Workflow ─────────────────────────────────────────── */}
        {showWorkflow && (
          <section className="panel jobs">
            <h2>Full Auto Workflow</h2>
            <p style={{ fontFamily: "var(--mono)", fontSize: "0.78rem", color: "var(--ink-2)", marginBottom: "0.85rem" }}>
              {'>'} parse CV → scan portals → optimize ATS ≥85 per job → generate LaTeX/HTML CV → apply
            </p>

            <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", alignItems: "flex-end", marginBottom: "1rem" }}>
              <div>
                <label style={{ display: "block", marginBottom: "0.3rem", fontFamily: "var(--mono)", fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--ink-2)" }}>Max jobs</label>
                <input
                  type="number" min={1} max={50} value={workflowMaxJobs}
                  onChange={(e) => setWorkflowMaxJobs(Number(e.target.value))}
                  style={{ width: 80 }}
                />
              </div>
              <label className="checkbox" style={{ margin: 0 }}>
                <input type="checkbox" checked={workflowAutoApply} onChange={(e) => setWorkflowAutoApply(e.target.checked)} />
                Auto-apply
              </label>
              <button
                type="button"
                disabled={isWorkflowRunning || !cv.trim() || apiKey.trim().length < 12}
                onClick={() => void startFullWorkflow()}
                style={{ width: "auto", padding: "8px 28px", boxShadow: isWorkflowRunning ? "none" : "var(--glow-green)" }}
              >
                {isWorkflowRunning ? "▸ RUNNING..." : "▸ LAUNCH WORKFLOW"}
              </button>
            </div>

            {workflowPhase && (
              <p style={{ fontFamily: "var(--mono)", fontSize: "0.8rem", color: "var(--purple)", marginBottom: "0.5rem" }}>
                STATUS: <strong style={{ color: "var(--green)" }}>{workflowPhase}</strong>
              </p>
            )}

            {workflowLog.length > 0 && (
              <div className="terminal-block">
                {workflowLog.map((line, i) => (
                  <div key={i} className={
                    line.startsWith("  →") ? "terminal-line-dim"
                    : line.toUpperCase().includes("ERROR") ? "terminal-line-red"
                    : line.toUpperCase().includes("DONE") ? "terminal-line-green"
                    : "terminal-line-cyan"
                  } style={{ marginBottom: "0.15rem" }}>
                    {line}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* ── CV Chatbot ─────────────────────────────────────────────────── */}
        {showChatbot && (
          <section className="panel jobs">
            <h2>CV Assistant</h2>
            <p style={{ fontFamily: "var(--mono)", fontSize: "0.78rem", color: "var(--ink-2)", marginBottom: "0.85rem" }}>
              {'>'} chat with AI to rewrite, optimize, or add keywords — changes apply to active CV
            </p>
            {!sessionId || apiKey.trim().length < 12 ? (
              <p className="empty">Enter API key to activate the CV assistant.</p>
            ) : (
              <CvChatbot
                cv={cv}
                provider={provider}
                apiKey={apiKey}
                sessionId={sessionId}
                onCvUpdated={(newCv) => {
                  setCv(newCv);
                  setTimeline(null); // re-parse timeline with new CV
                  setFeed((prev) => [{ id: crypto.randomUUID(), text: "CV updated by assistant — timeline will re-parse" }, ...prev].slice(0, 100));
                }}
              />
            )}
          </section>
        )}

        {/* ── My Applications + CV Versions ─────────────────────────────── */}
        {showUserData && (
          <section className="panel jobs">
            <h2 style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
              Application History
              <button type="button" onClick={() => void fetchAndShowUserData()}
                style={{ width: "auto", padding: "2px 14px", fontSize: "0.7rem" }}>
                REFRESH
              </button>
            </h2>

            {/* Applications table */}
            {userData && userData.applications.length > 0 ? (
              <div style={{ overflowX: "auto", marginBottom: "1.5rem" }}>
                <table className="cyber-table">
                  <thead>
                    <tr>
                      {["Date", "Company", "Role", "Location", "ATS", "Status", "Link"].map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {userData.applications.map((app, i) => (
                      <tr key={i}>
                        <td style={{ whiteSpace: "nowrap" }}>{new Date(app.submittedAt).toLocaleDateString()}</td>
                        <td style={{ fontFamily: "var(--mono)", fontSize: "0.7rem" }}>{app.company}</td>
                        <td>{app.jobTitle}</td>
                        <td style={{ color: "var(--ink-2)" }}>{app.jobLocation}</td>
                        <td>
                          {app.atsScore != null && (
                            <span className={`chip ${app.atsScore >= 85 ? "chip-green" : app.atsScore >= 70 ? "chip-amber" : "chip-red"}`}>
                              {app.atsScore}/100
                            </span>
                          )}
                        </td>
                        <td>
                          <span className={`chip ${app.status === "submitted" ? "chip-green" : app.status === "unsupported" ? "chip-cyan" : "chip-red"}`}>
                            {app.status === "submitted" ? "Applied ✓" : app.status === "unsupported" ? "Manual" : "Failed"}
                          </span>
                        </td>
                        <td>
                          <a href={app.jobUrl} target="_blank" rel="noreferrer" style={{ color: "var(--cyan)", fontSize: "0.75rem" }}>View →</a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="empty" style={{ marginBottom: "1rem" }}>No applications saved yet. Run the workflow to begin.</p>
            )}

            {/* CV Versions */}
            {userData && userData.cvVersions.length > 0 && (
              <>
                <h3 style={{ fontFamily: "var(--mono)", fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--purple)", marginBottom: "0.75rem" }}>CV Versions ({userData.cvVersions.length})</h3>
                <div className="cards">
                  {userData.cvVersions.slice(0, 10).map((ver) => (
                    <article key={ver.id} style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                      <p style={{ fontFamily: "var(--mono)", fontWeight: 600, fontSize: "0.8rem" }}>{ver.label}</p>
                      <p style={{ fontFamily: "var(--mono)", fontSize: "0.72rem", color: "var(--ink-2)" }}>{new Date(ver.createdAt).toLocaleString()}</p>
                      {ver.atsScore != null && (
                        <span className={`chip ${ver.atsScore >= 85 ? "chip-green" : "chip-red"}`} style={{ width: "fit-content" }}>
                          ATS {ver.atsScore}/100
                        </span>
                      )}
                      {ver.targetRole && <p style={{ fontFamily: "var(--mono)", fontSize: "0.72rem", color: "var(--ink-2)" }}>→ {ver.targetRole}</p>}
                      <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                        <button type="button" onClick={() => { setCv(ver.content); setTimeline(null); }}
                          style={{ width: "auto", fontSize: "0.7rem", padding: "2px 10px" }}>
                          Load CV
                        </button>
                        {ver.htmlUrl && (
                          <a href={`${API_BASE}${ver.htmlUrl}`} target="_blank" rel="noreferrer"
                            style={{ width: "auto", fontSize: "0.7rem", padding: "2px 10px", display: "inline-block",
                              border: "1px solid var(--green)", color: "var(--green)", textDecoration: "none", borderRadius: "var(--radius)" }}>
                            HTML
                          </a>
                        )}
                        {ver.latexUrl && (
                          <a href={`${API_BASE}${ver.latexUrl}`} download
                            style={{ width: "auto", fontSize: "0.7rem", padding: "2px 10px", display: "inline-block",
                              border: "1px solid var(--purple)", color: "var(--purple)", textDecoration: "none", borderRadius: "var(--radius)" }}>
                            .tex
                          </a>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        {/* ── Persistent Job History ─────────────────────────────────────── */}
        {showHistoryPanel && (
          <section className="panel jobs">
            <h2 style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
              Job History (DB)
              <span style={{ fontFamily: "var(--mono)", fontSize: "0.72rem", color: "var(--ink-2)", fontWeight: 400 }}>
                · {jobStats.applied} applied · {jobStats.shortlisted} shortlisted · {jobStats.rejected} rejected · {jobStats.total} total seen
              </span>
              <button
                type="button"
                onClick={() => setShowHistoryPanel(false)}
                style={{ width: "auto", padding: "2px 10px", fontSize: "0.7rem", marginLeft: "auto" }}
              >
                ✕ Close
              </button>
            </h2>
            <p style={{ fontFamily: "var(--mono)", fontSize: "0.78rem", color: "var(--ink-2)", marginBottom: "0.85rem" }}>
              {'>'} all jobs ever scanned — saved to disk and survive server restarts. New scans skip any URL already in this list.
            </p>
            {/* Filter buttons */}
            <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem", flexWrap: "wrap" }}>
              {(["all", "applied", "shortlisted", "rejected", "skipped"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => {
                    const filter = f === "all" ? undefined : f;
                    void fetchTrackedJobs(filter).then(setHistoryJobs);
                  }}
                  style={{ width: "auto", padding: "3px 12px", fontSize: "0.7rem",
                    color: f === "applied" ? "var(--green)" : f === "rejected" ? "var(--red)" : f === "shortlisted" ? "var(--cyan)" : "var(--ink-2)" }}
                >
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
            {historyJobs.length === 0 ? (
              <p className="empty">No jobs in the local DB yet. Run an autopilot scan to populate it.</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="table" style={{ width: "100%", fontSize: "0.78rem" }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left" }}>Company</th>
                      <th style={{ textAlign: "left" }}>Role</th>
                      <th style={{ textAlign: "right" }}>Score</th>
                      <th style={{ textAlign: "center" }}>Status</th>
                      <th style={{ textAlign: "right" }}>Scanned</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {historyJobs.slice(0, 200).map((job) => (
                      <tr key={job.url}>
                        <td style={{ fontWeight: 600 }}>{job.company}</td>
                        <td>{job.title}</td>
                        <td style={{ textAlign: "right", fontFamily: "var(--mono)" }}>{job.score}</td>
                        <td style={{ textAlign: "center" }}>
                          <span className={`chip ${job.status === "applied" ? "chip-green" : job.status === "rejected" ? "chip-red" : job.status === "shortlisted" ? "chip-blue" : ""}`}>
                            {job.status}
                          </span>
                        </td>
                        <td style={{ textAlign: "right", fontFamily: "var(--mono)", color: "var(--ink-2)", fontSize: "0.72rem" }}>
                          {new Date(job.scannedAt).toLocaleDateString()}
                        </td>
                        <td>
                          <a href={job.url} target="_blank" rel="noreferrer" style={{ color: "var(--cyan)", fontSize: "0.75rem" }}>View →</a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {historyJobs.length > 200 && (
                  <p style={{ fontFamily: "var(--mono)", fontSize: "0.7rem", color: "var(--ink-2)", marginTop: "0.5rem" }}>
                    Showing 200 of {historyJobs.length} — use filter buttons above to narrow results.
                  </p>
                )}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
