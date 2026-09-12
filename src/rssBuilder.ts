import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { FeedItem } from "./types.js";

export interface RssChannel {
  title: string;
  link: string;
  description: string;
}

const XML_FORBIDDEN_CONTROLS = new RegExp("[^\\P{Cc}\\t\\n\\r]", "gu");

/**
 * Strips control characters that are illegal in XML 1.0 content. Among the
 * Unicode Cc category only tab, LF, and CR are legal - keep those.
 */
function sanitizeText(value: string): string {
  return value.replace(XML_FORBIDDEN_CONTROLS, "");
}

/** Escapes XML text; & first so the other replacements are not double-encoded. */
export function escapeXml(value: string): string {
  return sanitizeText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** RFC-822 GMT pubDate, e.g. "Fri, 12 Sep 2026 07:17:00 GMT". */
export function toRfc822(date: Date): string {
  return date.toUTCString();
}

/**
 * Renders the RSS 2.0 document. `lastBuildDate` mirrors the newest item's
 * pubDate and is omitted for an empty feed, so an unchanged feed stays
 * byte-identical — no commit, no Pages rebuild, no downstream churn. Every
 * text node goes through escapeXml; no CDATA, so there is exactly one
 * encoding code path.
 */
export function buildRssXml(channel: RssChannel, items: readonly FeedItem[]): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    "  <channel>",
    `    <title>${escapeXml(channel.title)}</title>`,
    `    <link>${escapeXml(channel.link)}</link>`,
    `    <description>${escapeXml(channel.description)}</description>`,
    "    <language>ja</language>",
    "    <generator>aibench-teams-feed</generator>"
  ];
  const newest = items[0]?.pubDate;
  if (newest !== undefined) lines.push(`    <lastBuildDate>${escapeXml(newest)}</lastBuildDate>`);
  for (const item of items) {
    lines.push(
      "    <item>",
      `      <title>${escapeXml(item.title)}</title>`,
      `      <link>${escapeXml(item.link)}</link>`,
      `      <guid isPermaLink="false">${escapeXml(item.guid)}</guid>`,
      `      <pubDate>${escapeXml(item.pubDate)}</pubDate>`,
      `      <description>${escapeXml(item.description)}</description>`,
      "    </item>"
    );
  }
  lines.push("  </channel>", "</rss>", "");
  const xml = lines.join("\n");
  validateRssXml(xml, "generated RSS");
  return xml;
}

/** Parses the document back to prove well-formedness and RSS shape. */
export function validateRssXml(xml: string, label: string): void {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    const message = validation.err?.msg ?? "malformed XML";
    throw new Error(`${label} is not well-formed: ${message}`);
  }
  const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml) as unknown;
  if (!parsed || typeof parsed !== "object" || !("rss" in parsed)) {
    throw new Error(`${label} is not an RSS document`);
  }
}

/** Writes the XML only when its bytes change; returns whether it changed. */
export function writeRssIfChanged(target: string, xml: string): boolean {
  if (existsSync(target) && readFileSync(target, "utf8") === xml) return false;
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, xml, "utf8");
  renameSync(temporary, target);
  return true;
}
