// LaTeX language support for CodeMirror: legacy stex tokenizer, theme, and completions.
import { StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { EditorView } from '@codemirror/view';
import { snippetCompletion } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';

export const latexLanguage = StreamLanguage.define({
  ...stex,
  languageData: { commentTokens: { line: '%' }, closeBrackets: { brackets: ['(', '[', '{'] } },
});

// stex emits: tag = \commands, atom = names inside \begin{} \ref{} \usepackage{}, keyword = math shifts.
export const latexHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: t.tagName, color: '#e2b35f' },
  { tag: t.atom, color: '#93b9e6' },
  { tag: t.keyword, color: '#c9a2ec' },
  { tag: t.bracket, color: '#7c8595' },
  { tag: t.number, color: '#8fc9a1' },
  { tag: t.string, color: '#9fd0c0' },
  { tag: t.comment, color: '#5f6776', fontStyle: 'italic' },
  { tag: t.invalid, color: '#e76f72' },
]));

export const editorTheme = EditorView.theme({
  '&': { color: 'var(--ink)', backgroundColor: 'var(--panel)', height: '100%', fontSize: 'var(--editor-size, 14px)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.7' },
  '.cm-content': { caretColor: 'var(--leaf-hi)', padding: '12px 0 45vh' },
  '.cm-line': { padding: '0 18px 0 10px' },
  '.cm-gutters': { backgroundColor: 'var(--panel)', color: '#465061', border: 'none', paddingLeft: '6px' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '3ch', fontVariantNumeric: 'tabular-nums' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--leaf)' },
  '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,.028)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--leaf-hi)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'rgba(214,166,79,.24) !important' },
  '.cm-selectionMatch': { backgroundColor: 'rgba(147,185,230,.14)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'rgba(214,166,79,.18)', color: 'inherit', outline: '1px solid rgba(214,166,79,.35)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--raise)', border: 'none', color: 'var(--ink-2)' },
  '.cm-tooltip': { backgroundColor: 'var(--panel-2)', border: '1px solid var(--rule-strong)', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 12px 32px rgba(0,0,0,.45)' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--mono)', fontSize: '12.5px', maxHeight: '16em' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '3px 10px !important' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--leaf-wash)', color: 'var(--leaf-hi)' },
  '.cm-completionDetail': { color: 'var(--dim)', fontStyle: 'normal', marginLeft: '1em' },
  '.cm-panels': { backgroundColor: 'var(--panel-2)', color: 'var(--ink)', borderColor: 'var(--rule)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--rule)' },
  '.cm-search': { fontFamily: 'var(--ui)', fontSize: '12.5px', padding: '8px 10px' },
  '.cm-search input, .cm-search button': { fontFamily: 'var(--ui)', borderRadius: '6px' },
  '.cm-textfield': { backgroundColor: 'var(--desk)', border: '1px solid var(--rule-strong)', color: 'var(--ink)', padding: '3px 8px' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--raise)', border: '1px solid var(--rule-strong)', color: 'var(--ink)' },
  '.cm-searchMatch': { backgroundColor: 'rgba(214,166,79,.2)', outline: '1px solid rgba(214,166,79,.45)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(214,166,79,.4)' },
  '.cm-diagnostic': { fontFamily: 'var(--ui)', fontSize: '12.5px', padding: '6px 10px' },
  '.cm-diagnostic-error': { borderLeft: '3px solid var(--err)' },
  '.cm-diagnostic-warning': { borderLeft: '3px solid var(--warn)' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy rgba(231,111,114,.8)', textUnderlineOffset: '3px' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy rgba(227,163,95,.55)', textUnderlineOffset: '3px' },
  '.cm-gutter-lint': { width: '12px' },
  '.cm-lint-marker': { width: '8px', height: '8px', borderRadius: '50%', content: 'none', marginTop: '6px' },
  '.cm-lint-marker-error': { backgroundColor: 'var(--err)' },
  '.cm-lint-marker-warning': { backgroundColor: 'var(--warn)' },
  '.cm-flash-line': { backgroundColor: 'rgba(214,166,79,.16)', transition: 'background-color .8s' },
  // lines changed by Claude and not reviewed yet
  '.cm-rv-changed': { backgroundColor: 'rgba(95,180,127,.08)', boxShadow: 'inset 3px 0 0 #5fb47f' },
  '.cm-rv-removed': { boxShadow: 'inset 0 2px 0 #d9676a' },
}, { dark: true });

const COMMANDS = `section subsection subsubsection paragraph chapter part textbf textit emph underline texttt textsc textsf
cite citep citet ref eqref autoref cref Cref pageref label includegraphics caption centering item footnote url href
frac dfrac tfrac sqrt sum int iint oint prod lim limsup liminf infty partial nabla alpha beta gamma Gamma delta Delta
epsilon varepsilon zeta eta theta Theta vartheta iota kappa lambda Lambda mu nu xi Xi pi Pi rho sigma Sigma tau
upsilon phi Phi varphi chi psi Psi omega Omega mathbb mathcal mathbf mathrm mathsf mathit boldsymbol left right
big Big bigg Bigg cdot cdots ldots vdots ddots times div pm mp leq geq neq approx equiv sim simeq propto in notin
subset subseteq supset cup cap setminus emptyset forall exists neg land lor implies iff to mapsto rightarrow
leftarrow Rightarrow Leftarrow leftrightarrow langle rangle lfloor rfloor lceil rceil vec hat bar tilde dot ddot
overline underline overbrace underbrace boxed text operatorname quad qquad usepackage documentclass maketitle
tableofcontents listoffigures newcommand renewcommand DeclareMathOperator hline toprule midrule bottomrule
multicolumn multirow vspace hspace newpage clearpage noindent linewidth textwidth today bibliography
bibliographystyle printbibliography addbibresource input include title author date appendix begin end`.split(/\s+/);

const ENVIRONMENTS = `equation equation* align align* gather gather* multline split cases itemize enumerate description
figure figure* table table* tabular tabularx center flushleft flushright abstract theorem lemma corollary
proposition definition remark example proof matrix pmatrix bmatrix vmatrix array verbatim minipage quote
quotation thebibliography frame columns column tikzpicture subfigure algorithm algorithmic lstlisting minted`.split(/\s+/);

const REF_CMDS = /\\(?:ref|eqref|autoref|cref|Cref|pageref|vref|nameref)\{([^}]*)$/;
const CITE_CMDS = /\\(?:cite|citep|citet|parencite|textcite|autocite|nocite)(?:\[[^\]]*\])*\{(?:[^}]*,)?\s*([^,}]*)$/;

// getContext() -> { labels: string[], citations: string[] }
export function latexCompletions(getContext) {
  const commandOptions = COMMANDS.map((c) => ({ label: '\\' + c, type: 'keyword' }));
  return (ctx) => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);

    let m = before.match(/\\begin\{([^}]*)$/);
    if (m) {
      return {
        from: ctx.pos - m[1].length,
        options: ENVIRONMENTS.map((env) => snippetCompletion(`${env}}\n\t\${}\n\\end{${env}}`, { label: env, type: 'type' })),
        validFor: /^[\w*]*$/,
      };
    }
    m = before.match(REF_CMDS);
    if (m) {
      return { from: ctx.pos - m[1].length, options: getContext().labels.map((l) => ({ label: l, type: 'variable' })), validFor: /^[^},]*$/ };
    }
    m = before.match(CITE_CMDS);
    if (m) {
      return { from: ctx.pos - m[1].length, options: getContext().citations.map((c) => ({ label: c.key, detail: c.title, type: 'text' })), validFor: /^[^},\s]*$/ };
    }
    const word = ctx.matchBefore(/\\[a-zA-Z]*/);
    if (!word || (word.from === word.to && !ctx.explicit)) return null;
    return { from: word.from, options: commandOptions, validFor: /^\\[a-zA-Z]*$/ };
  };
}

export function scanLabels(text) {
  const out = new Set();
  for (const m of text.matchAll(/\\label\{([^}]+)\}/g)) out.add(m[1]);
  return [...out];
}

export function scanBib(text) {
  const out = [];
  for (const m of text.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,([\s\S]*?)(?=\n@|\s*$)/g)) {
    const title = m[2].match(/title\s*=\s*[{"]+([^}"]+)/i)?.[1];
    out.push({ key: m[1], title: title ? title.slice(0, 60) : '' });
  }
  return out;
}
