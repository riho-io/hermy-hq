import type { ReactNode } from 'react';

// Minimal markdown for agent reports: headings, lists, rules, code fences, **bold**, `code`, links.
// Builds React elements only (no dangerouslySetInnerHTML), so report text can never inject markup.

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s)<>\]]+)/g;

function link(href: string, text: string, key: number) {
  return (
    <a key={key} href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] underline underline-offset-2 break-all">
      {text}
    </a>
  );
}

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (i % 2 === 0) return part;
    if (part.startsWith('**')) return <strong key={i} className="font-semibold text-[var(--text)]">{part.slice(2, -2)}</strong>;
    if (part.startsWith('`')) return <code key={i} className="px-1 rounded bg-[var(--surface-2)] text-[12px]">{part.slice(1, -1)}</code>;
    if (part.startsWith('[')) {
      const m = /^\[([^\]]+)\]\((.+)\)$/.exec(part)!;
      return link(m[2], m[1], i);
    }
    return link(part, part, i);
  });
}

export function ReportBody({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const lines = text.split(/\r?\n/);
  let list: ReactNode[] = [];

  const flushList = () => {
    if (list.length) out.push(<ul key={`ul${out.length}`} className="my-2 ml-5 list-disc space-y-1">{list}</ul>);
    list = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const key = `l${i}`;

    if (line.startsWith('```')) {
      flushList();
      const code: string[] = [];
      while (++i < lines.length && !lines[i].startsWith('```')) code.push(lines[i]);
      out.push(
        <pre key={key} className="my-3 p-3 rounded-lg bg-[var(--surface-2)] text-[12px] overflow-x-auto whitespace-pre-wrap">
          {code.join('\n')}
        </pre>,
      );
      continue;
    }

    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      list.push(<li key={key}>{inline(bullet[1])}</li>);
      continue;
    }
    flushList();

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const size = ['text-[22px]', 'text-[18px]', 'text-[15px]', 'text-[14px]'][heading[1].length - 1];
      out.push(
        <p key={key} className={`${size} mt-6 mb-2 font-semibold tracking-[-0.01em] text-[var(--text)]`}>
          {inline(heading[2])}
        </p>,
      );
    } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push(<hr key={key} className="my-5 border-[var(--line)]" />);
    } else if (line.trim()) {
      out.push(<p key={key} className="my-1.5">{inline(line)}</p>);
    }
  }
  flushList();

  return <div className="text-[13.5px] leading-relaxed text-[var(--text-2)] break-words">{out}</div>;
}
