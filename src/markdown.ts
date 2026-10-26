import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";

for (const [name, language] of Object.entries({javascript, typescript, python, bash, json}))
  hljs.registerLanguage(name, language);
const markdown = new MarkdownIt({html: false, linkify: true, breaks: true, typographer: false});
markdown.validateLink = (url) => /^(https?:\/\/|mailto:)/i.test(url);
markdown.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx], raw = token.content;
  const language = token.info.trim().split(/\s+/)[0].toLowerCase();
  const supported = hljs.getLanguage(language) != null;
  const code = supported ? hljs.highlight(raw, {language, ignoreIllegals:true}).value
    : markdown.utils.escapeHtml(raw);
  const b64 = Array.from(new TextEncoder().encode(raw), byte => String.fromCharCode(byte)).join("");
  // Encode code separately; button uses visible <code> innerText, never evaluates HTML.
  return '<div class="code-block"><div class="code-head"><span>' +
    markdown.utils.escapeHtml(language || "text") +
    '</span><button class="copy-code" type="button">复制代码</button></div>' +
    '<pre><code>' + code + '</code></pre></div>';
};
export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(markdown.render(text), {
    ALLOWED_TAGS: ["p","h1","h2","h3","h4","h5","h6","a","strong","em","del","ul","ol",
      "li","pre","code","div","span","blockquote","table","thead","tbody","tr","th","td","hr","br","button",
      "input"],
    ALLOWED_ATTR: ["class","href","type","checked","disabled","title"],
    ALLOW_DATA_ATTR: false,
  });
}
