# knowledge-assistant

An **enterprise AI knowledge assistant**: employees ask questions in Thai or English, and it answers from your
company's own documents (policies, handbooks, manuals) **with numbered sources and quotes**, powered by Claude (Claude Opus 5.5).

```
> How many days of annual leave do I get?
  🔎 "annual leave days" → 4 passages
You get 10 days of paid annual leave after one year[1]. From your 3rd year it's 12 days,
and you can carry over up to 5 unused days, which must be used by 31 March[1].

Sources:
  [1] leave policy · Annual leave / ลาพักร้อน (updated 2026-11-08)  docs/public/leave-policy.md
       “Employees who have worked at least 1 year get 10 days of paid annual leave per year…”
```

## What makes it "enterprise"

| Feature | How |
|---|---|
| **Answers with sources** | Every statement is linked to the exact passage it came from (Claude's search-result citations), so people can check it. |
| **No guessing** | If the documents don't say it, the assistant says so and tells people who to ask. |
| **Access control** | Documents are grouped by folder (`public`, `hr`, `finance`…). Each user only searches the groups they're allowed. Restricted files never reach the AI for that user. |
| **Audit log** | Every question, user, search and cited source is written to `logs/audit-YYYY-MM.jsonl`, including denied attempts to open restricted files. |
| **Thai + English** | The search engine splits Thai text into words, so Thai questions find Thai and English passages. |
| **Many formats** | PDF (with page numbers), Word (.docx), Markdown, text, HTML, CSV |
| **Safe with documents** | Text inside documents is treated as data, so instructions hidden in a file can't take over the assistant. |

## Setup (one time)

1. Get a Claude API key at https://platform.claude.com → *API Keys*.
2. Create **`.env`** in this folder:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
3. Dependencies are already installed. In a fresh copy, run `npm install`.

## Add your documents

Put files in **`docs\<group>\`**. The first folder level is the access group:

```
docs\
  public\    leave-policy.pdf, it-support.docx, company-overview.md   ← everyone
  finance\   expense-policy.pdf                                         ← finance + selected staff
  hr\        salary-bands.xlsx → save as PDF/CSV first                   ← HR only
```

On the first run, the **sample documents** (a made-up company) are copied into `docs\` so you can try it.
Delete them when you add your own. After adding or changing files, type `/reindex` (or restart).
Unchanged files aren't read again.

## Users and access (`config.json`)

```json
"users": {
  "admin": { "name": "Administrator", "access": ["*"] },
  "staff": { "name": "Staff member",  "access": ["public", "finance"] },
  "hr":    { "name": "HR team",       "access": ["public", "finance", "hr"] }
}
```

Also set `company_name` and `help_contact` (who people should ask when the documents don't cover something).

> **Important:** this terminal version lets you *choose* a user (`--user staff`) to show how permissions work.
> For real company use, connect it to your company login (Microsoft 365 / Google Workspace) so people can't
> pick someone else's access. This is the first thing to add before rolling it out.

## Run it

```powershell
cd C:\Users\Dell\knowledge-assistant
node assistant.mjs --user staff
```

| Command | What it does |
|---|---|
| `/docs` | List the documents you can access |
| `/reindex` | Re-read the docs folder after adding or changing files |
| `/new` | Start a new conversation |
| `/exit` | Quit (Ctrl+C stops an answer) |

Try: "How many days of annual leave do I get?", "ลาป่วยกี่วันต้องมีใบรับรองแพทย์", "What's the hotel limit in Bangkok?",
"How do I reset my password?", "What's the salary range for managers?" (try it as `staff`, then as `hr`).

## Settings (in `.env`)

```
KA_MODEL=claude-opus-5-5   # default
KA_EFFORT=medium           # low = faster answers, high = more thorough searching
DOCS_DIR=docs              # where the documents are
```

## Cost

About 1–4 US cents per question (each answer shows a running total). Prompt caching makes follow-up questions cheaper.

## Privacy

- Only the passages found for a question are sent to Anthropic. Whole documents aren't uploaded.
- `docs\`, the search index (`.index\`) and the audit logs (`logs\`) are excluded from git. Never commit company documents.

## Files

| File | Role |
|---|---|
| `assistant.mjs` | The chat: Claude, tools, citations, sign-in, audit log |
| `knowledge.mjs` | Reads documents, splits them into passages, Thai/English search, access checks |
| `config.json` | Company name, help contact, users and their access |
| `sample-docs\` | The made-up sample company documents |
