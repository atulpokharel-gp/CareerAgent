# Career-Ops local workspace

Run `npm install` and `npm run ui`, then open http://localhost:4317. On Windows, `start-ui.bat` also starts this workspace. The server listens only on loopback.

1. Enter basic information, target roles, work preference, and compensation.
2. Upload a PDF/Markdown/text CV, paste text, or explicitly reuse the existing CV. Review extracted text before continuing.
3. Choose a scan frequency and select **Save & launch search**.

Setup updates the canonical `cv.md` and `config/profile.yml` while preserving unrelated profile fields. Previous versions are backed up in `data/onboarding-backups/`. Uploaded PDF files are deleted after extraction. PDF extraction requires `pdftotext` on PATH or Python with `pypdf`; pasting text always works.

The background worker runs the portal scanner using a generated search configuration, verifies discoveries in Playwright, compares job titles to target titles, and writes review packets for up to 12 discoveries per run. The shortlist contains only postings checked as active in the browser. Unconfirmed postings are retried in a later run. Packets contain a posting link, review checklist, and the source CV. They are **not** full fit evaluations, tailored CVs, or completed application forms. Skills, salary, work authorization, and deal-breakers still require a full evaluation before applying. The existing application pipeline remains available from the sidebar.

Progress, discoveries, schedules, and setup are stored under `data/`. Recurring scans resume after server restart; scans scheduled while the server is off run when it restarts. Keep the server running for on-time scans. Pause cancels scans and scheduling; an in-progress browser check may finish before pausing. No application is submitted automatically.

Data follows `CAREER_OPS_ROOT` / the project's data-root marker. The local UI is a single-user workspace, not an account-based hosted service.

Run `npm run test:automation` for isolated workflow tests. No test scans live portals or modifies the canonical user profile.
