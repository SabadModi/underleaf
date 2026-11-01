// Markdown language support for CodeMirror, highlighted in the same palette as the LaTeX mode.
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

// lang-markdown emits: heading, emphasis/strong, link/url, monospace = code, quote,
// processingInstruction = the # * ` > marks themselves, contentSeparator = rules.
const markdownHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: t.heading, color: '#e2b35f', fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: '#93b9e6' },
  { tag: t.url, color: '#7c8595' },
  { tag: t.monospace, color: '#9fd0c0' },
  { tag: t.quote, color: '#c9a2ec' },
  { tag: [t.processingInstruction, t.contentSeparator, t.labelName], color: '#7c8595' },
  { tag: t.comment, color: '#5f6776', fontStyle: 'italic' },
  { tag: t.meta, color: '#7c8595' },
]));

// The YAML header at the top (pandoc's title, author, bibliography…): metadata, not a setext heading.
const frontMatter = {
  defineNodes: [{ name: 'FrontMatter', block: true, style: t.meta }],
  parseBlock: [{
    name: 'FrontMatter',
    before: 'HorizontalRule',
    parse(cx, line) {
      if (cx.lineStart !== 0 || !/^---\s*$/.test(line.text)) return false;
      let closed = false;
      while (cx.nextLine()) if (/^(---|\.\.\.)\s*$/.test(line.text)) { closed = true; break; }
      if (closed) cx.nextLine();
      cx.addElement(cx.elt('FrontMatter', 0, cx.prevLineEnd()));
      return true;
    },
  }],
};

export const markdownSupport = [markdown({ base: markdownLanguage, extensions: [frontMatter] }), markdownHighlight];
