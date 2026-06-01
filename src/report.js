import { summarize } from "./ledger.js";

export function renderReport(events, options = {}) {
  const summary = summarize(events);
  const title = options.title ?? "Agent Run Ledger";
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #18201b;
      --muted: #5d695f;
      --paper: #fbfaf4;
      --line: #d9dfd3;
      --panel: #ffffff;
      --green: #226b45;
      --red: #a0352c;
      --amber: #8a5a12;
      --blue: #245f82;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: var(--paper);
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
    }

    main {
      max-width: 1120px;
      margin: 0 auto;
      padding: 40px 20px 56px;
    }

    header {
      border-bottom: 1px solid var(--line);
      padding-bottom: 22px;
      margin-bottom: 28px;
    }

    h1 {
      font-size: clamp(2rem, 4vw, 4rem);
      line-height: 1;
      margin: 0 0 12px;
      letter-spacing: 0;
    }

    h2 {
      font-size: 1.1rem;
      margin: 0 0 14px;
    }

    p {
      margin: 0;
    }

    .meta {
      color: var(--muted);
      max-width: 760px;
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 12px;
      margin-bottom: 28px;
    }

    .stat,
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }

    .stat {
      padding: 16px;
    }

    .stat strong {
      display: block;
      font-size: 1.8rem;
      line-height: 1;
      margin-bottom: 6px;
    }

    .stat span,
    .small {
      color: var(--muted);
      font-size: 0.9rem;
    }

    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1.5fr) minmax(280px, 0.8fr);
      gap: 18px;
      align-items: start;
    }

    section {
      padding: 18px;
      margin-bottom: 18px;
    }

    .timeline {
      display: grid;
      gap: 12px;
    }

    .event {
      border-left: 4px solid var(--blue);
      padding: 10px 0 10px 14px;
    }

    .event.failed,
    .event.blocked {
      border-left-color: var(--red);
    }

    .event.passed,
    .event.done {
      border-left-color: var(--green);
    }

    .event.skipped,
    .event.planned {
      border-left-color: var(--amber);
    }

    .event-title {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      margin-bottom: 4px;
    }

    .event-title strong {
      font-size: 1rem;
    }

    .pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      font-size: 0.78rem;
      padding: 2px 8px;
      white-space: nowrap;
    }

    ul {
      margin: 10px 0 0;
      padding-left: 20px;
    }

    code {
      background: #eef1ea;
      border: 1px solid #dde4d8;
      border-radius: 6px;
      padding: 1px 6px;
      word-break: break-word;
    }

    .empty {
      color: var(--muted);
      font-style: italic;
    }

    @media (max-width: 780px) {
      main {
        padding: 28px 14px 40px;
      }

      .grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${escapeHtml(title)}</h1>
      <p class="meta">Generated ${escapeHtml(formatDate(generatedAt))}. ${escapeHtml(summaryLine(summary))}</p>
    </header>

    <div class="stats">
      <div class="stat"><strong>${summary.eventCount}</strong><span>events</span></div>
      <div class="stat"><strong>${summary.files.length}</strong><span>files referenced</span></div>
      <div class="stat"><strong>${summary.commands.length}</strong><span>commands recorded</span></div>
      <div class="stat"><strong>${summary.attention.length}</strong><span>items needing attention</span></div>
    </div>

    <div class="grid">
      <section>
        <h2>Timeline</h2>
        <div class="timeline">
          ${events.map(renderEvent).join("\n")}
        </div>
      </section>

      <aside>
        <section>
          <h2>Review Focus</h2>
          ${renderAttention(summary.attention)}
        </section>

        <section>
          <h2>Files</h2>
          ${renderList(summary.files, (file) => `<code>${escapeHtml(file)}</code>`)}
        </section>

        <section>
          <h2>Commands</h2>
          ${renderList(summary.commands, (item) => `<code>${escapeHtml(item.command)}</code> <span class="pill">${escapeHtml(item.status)}</span>`)}
        </section>
      </aside>
    </div>
  </main>
</body>
</html>
`;
}

function renderEvent(event) {
  const status = event.status ?? "done";
  const rows = [];

  if (event.files?.length) {
    rows.push(`<li>Files: ${event.files.map((file) => `<code>${escapeHtml(file)}</code>`).join(" ")}</li>`);
  }

  if (event.commands?.length) {
    rows.push(`<li>Commands: ${event.commands.map((command) => `<code>${escapeHtml(command)}</code>`).join(" ")}</li>`);
  }

  if (event.links?.length) {
    rows.push(`<li>Links: ${event.links.map((link) => `<a href="${escapeAttribute(link)}">${escapeHtml(link)}</a>`).join(" ")}</li>`);
  }

  return `<article class="event ${escapeAttribute(status)}">
  <div class="event-title">
    <strong>${escapeHtml(event.title)}</strong>
    <span class="pill">${escapeHtml(event.type)}</span>
    <span class="pill">${escapeHtml(status)}</span>
    <span class="pill">${escapeHtml(formatDate(event.ts))}</span>
  </div>
  <p>${escapeHtml(event.summary)}</p>
  ${rows.length ? `<ul>${rows.join("")}</ul>` : ""}
</article>`;
}

function renderAttention(events) {
  if (events.length === 0) {
    return `<p class="empty">No failed, blocked, or skipped items were recorded.</p>`;
  }

  return renderList(events, (event) => `${escapeHtml(event.title)} <span class="pill">${escapeHtml(event.status ?? event.type)}</span>`);
}

function renderList(items, renderItem) {
  if (items.length === 0) {
    return `<p class="empty">None recorded.</p>`;
  }

  return `<ul>${items.map((item) => `<li>${renderItem(item)}</li>`).join("")}</ul>`;
}

function summaryLine(summary) {
  if (!summary.startedAt || !summary.finishedAt) {
    return "No run timing was recorded.";
  }

  return `Run window: ${formatDate(summary.startedAt)} to ${formatDate(summary.finishedAt)}.`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}
