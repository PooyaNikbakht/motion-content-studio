/*
 * Conversation parser. Plain JS, no dependencies, works in the browser
 * (window.MBSParser) and in Node (require). See README "Assumed formats".
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MBSParser = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULT_START_PHRASE = "Today the sea is very calm"; // the demo and /format default; in /app the phrase is set once in Setup
  const RTL_RE = /[֐-׿\u0600-\u06FF\u0750-\u077Fיִ-\uFDFF\uFE70-\uFEFF]/;
  const RTL_LANGS = ["fa", "ar", "he", "ur"];

  /** Persian and Arabic-Indic digits to 0-9. */
  function toLatinDigits(s) {
    return s
      .replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
      .replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660));
  }

  /** Comparison form: Latin digits, no ZWNJ or direction marks, Persian letter forms, single spaces. */
  function fold(s) {
    return toLatinDigits(s)
      .replace(/[‌‍‎‏‪-‮]/g, "")
      .replace(/\u0643/g, "\u06A9")
      .replace(/[\u064A\u0649]/g, "\u06CC")
      .replace(/[\u064B-\u0652\u0640]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  /** Strip markdown decoration from a line so labels can be matched. */
  function clean(line) {
    return line
      .replace(/\*\*|__/g, "")
      .replace(/^\s*(#+\s*|>+\s*|[-*•]\s+)+/, "")
      .replace(/^[\s"'“”«]+/, "")
      .trim();
  }

  function stripBold(s) {
    return s.replace(/\*\*|__/g, "");
  }

  function unquote(s) {
    return s.trim().replace(/^["'“«]+/, "").replace(/["'”»]+$/, "").trim();
  }

  function hasRtl(s) {
    return RTL_RE.test(s);
  }

  /** Keep the lines without Persian/Arabic/Hebrew letters. Falls back to the input if nothing is left. */
  function englishOnly(text) {
    const kept = text.split("\n").filter((l) => !hasRtl(l)).join("\n").trim();
    return kept || text.trim();
  }

  /** Guess the content language from the letters used. */
  function detectLanguage(text) {
    let arabic = 0, hebrew = 0, latin = 0, persianOnly = 0, urduOnly = 0;
    for (const ch of text) {
      if (/[֐-׿]/.test(ch)) hebrew++;
      else if (/[\u0600-\u06FF\u0750-\u077F]/.test(ch)) {
        arabic++;
        if (/[\u067E\u0686\u0698\u06AF]/.test(ch)) persianOnly++;
        if (/[\u0679\u0688\u0691\u06BA\u06BE\u06C1\u06D2]/.test(ch)) urduOnly++;
      } else if (/[A-Za-z]/.test(ch)) latin++;
    }
    if (hebrew > arabic && hebrew > latin * 0.3) return "he";
    if (arabic > latin * 0.3 && arabic > 0) {
      if (urduOnly > 0 && persianOnly === 0) return "ur";
      return persianOnly > 0 || /[\u06CC\u06A9]/.test(text) ? "fa" : "ar";
    }
    return "en";
  }

  function isRtlLang(lang) {
    return RTL_LANGS.includes(lang);
  }

  /** Per line: true while inside a fenced code block, including the fence lines. */
  function fenceMask(lines) {
    const mask = new Array(lines.length).fill(false);
    let open = null;
    lines.forEach((l, i) => {
      const m = /^\s*(```|~~~)/.exec(l);
      if (open) {
        mask[i] = true;
        if (m && m[1] === open) open = null;
      } else if (m) {
        mask[i] = true;
        open = m[1];
      }
    });
    return mask;
  }

  /** Content of the first code block starting in [from, to). Returns null if there is none. */
  function codeBlock(lines, from, to) {
    for (let i = from; i < to; i++) {
      const m = /^\s*(```|~~~)/.exec(lines[i]);
      if (!m) continue;
      const body = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (new RegExp("^\\s*" + m[1]).test(lines[j])) break;
        body.push(lines[j]);
      }
      return body.join("\n").trim();
    }
    return null;
  }

  /** Prompt that follows a label on line `i`: same line text, then a code block, then plain lines. */
  function promptAfter(lines, i, to) {
    const rest = clean(lines[i]).replace(/^[^:：]*[:：]/, "").trim();
    const block = codeBlock(lines, i + 1, Math.min(to, i + 8));
    if (block) return englishOnly(block);
    if (rest) return englishOnly(unquote(rest));
    const plain = [];
    for (let j = i + 1; j < to && plain.length < 6; j++) {
      if (!lines[j].trim()) {
        if (plain.length) break;
        continue;
      }
      plain.push(clean(lines[j]));
    }
    return englishOnly(plain.join("\n"));
  }

  const SCENE_NUMBER_RE = /^scene\s*number\s*[:：]?\s*\[?\s*(\d+)\s*\]?/;
  const SCENE_ANY_RE = /^scene\s*(?:number\s*)?[:#]?\s*\[?\s*(\d+)\s*\]?/;
  const CHUNK_LABEL_RE = /^(?:audio\s*)?(?:chunk|part|\u0628\u062E\u0634|\u0642\u0633\u0645\u062A)\s*(\d+)/;
  const STEP_RE = /^(?:step|stage|phase|\u0645\u0631\u062D\u0644\u0647)\s*(\d+)/;
  const LABEL_RE = /^(?:image prompt|video prompt|narration part|thumbnail|reel\b|cover prompt|(?:chunk|audio|part|\u0628\u062E\u0634|\u0642\u0633\u0645\u062A)\s*\d|\u0631\u06CC\u0644[\u0632\u0633]?\s*\d)/;
  // Heading of the Reels and Shorts package (Step 6), with or without a step number.
  const REELS_HEAD_RE = /(?:reels?\s*(?:and|&|\+|\/)\s*shorts?|shorts?\s*(?:and|&|\+|\/)\s*reels?|\u0631\u06CC\u0644[\u0632\u0633]?\s*(?:\u0648|\/|&)\s*\u0634\u0648\u0631\u062A)/;
  // "Reel Cover Prompt:" / "Cover Prompt" / "Reel Cover (9:16):" label line (colon optional when nothing follows).
  const COVER_RE = /^(?:vertical\s+)?(?:reel\s+)?(?:cover|\u06a9\u0627\u0648\u0631)\s*(?:image\s*)?(?:prompt)?\s*(?:\([^)]*\))?\s*(?:[:\uff1a]|$)/i;
  const REEL_START_RE = /^(?:reel|short|\u0631\u06CC\u0644[\u0632\u0633]?|\u0634\u0648\u0631\u062A[\u0632\u0633]?)\s*(?:number|no\.?|#|\u0634\u0645\u0627\u0631\u0647)?\s*[:\[]?\s*(\d+)\s*\]?\s*[:\-.\u2013\u2014]?\s*(.*)$/;

  function normalize(text) {
    return String(text || "")
      .replace(/^\uFEFF/, "")
      .replace(/\r\n?/g, "\n")
      .replace(/ /g, " ");
  }

  function parseChunks(lines, mask, startPhrase, from, to) {
    from = from || 0;
    to = to === undefined ? lines.length : to;
    const phrase = fold(startPhrase || "");
    if (!phrase) return [];
    const phraseHasNonAscii = /[^\x00-\x7f]/.test(phrase);
    const folded = lines.map((l) => fold(clean(l)));
    const starts = (i) => !mask[i] && folded[i].startsWith(phrase);
    const isMarker = (i) => {
      const raw = lines[i];
      if (mask[i]) return true;
      if (/^\s*#/.test(raw)) return true;
      if (/^\s*([-*_])\1{2,}\s*$/.test(raw)) return true;
      const f = folded[i];
      if (STEP_RE.test(f) || SCENE_ANY_RE.test(f) || LABEL_RE.test(f) || seoLabel(clean(raw)) || (f.length < 80 && REELS_HEAD_RE.test(f))) return true;
      // Latin-only commentary from the director ends a non-Latin narration block.
      if (phraseHasNonAscii && !/[^\x00-\x7f]/.test(f) && (f.match(/[a-z]/g) || []).length >= 3) return true;
      return false;
    };
    // "Audio chunk 3" above a chunk numbers it: when the same number shows up twice the later one is the regenerated version.
    const labelOf = (i) => {
      for (let k = i - 1; k >= Math.max(from, i - 3); k--) {
        if (!lines[k].trim()) continue;
        const m = CHUNK_LABEL_RE.exec(folded[k]);
        return m ? parseInt(m[1], 10) : 0;
      }
      return 0;
    };
    const found = [];
    for (let i = from; i < to; i++) {
      if (!starts(i)) continue;
      const label = labelOf(i);
      const body = [stripBold(lines[i]).replace(/^\s*(#+\s*|>+\s*)/, "")];
      let j = i + 1;
      while (j < to && !starts(j) && !isMarker(j)) {
        body.push(stripBold(lines[j]).replace(/^\s*>+\s*/, ""));
        j++;
      }
      const text = body.join("\n").replace(/\n{3,}/g, "\n\n").trim();
      found.push({ label, text });
      i = j - 1;
    }
    const chunks = [], at = new Map();
    found.forEach((f) => {
      if (f.label && at.has(f.label)) { chunks[at.get(f.label)].text = f.text; chunks[at.get(f.label)].chars = [...f.text].length; return; }
      if (f.label) at.set(f.label, chunks.length);
      chunks.push({ n: chunks.length + 1, text: f.text, chars: [...f.text].length });
    });
    return chunks;
  }

  function parseScenes(lines, mask) {
    const folded = lines.map((l) => fold(clean(l)));
    const idx = [];
    folded.forEach((f, i) => {
      if (mask[i]) return;
      const m = SCENE_NUMBER_RE.exec(f);
      if (m) idx.push({ i, number: parseInt(m[1], 10) });
    });
    return idx.map((s, k) => {
      let end = k + 1 < idx.length ? idx[k + 1].i : lines.length;
      for (let j = s.i + 1; j < end; j++) {
        if (!mask[j] && STEP_RE.test(folded[j])) { end = j; break; }
      }
      let narration = "", imagePrompt = "";
      for (let j = s.i + 1; j < end; j++) {
        if (mask[j]) continue;
        if (/^narration\s*part/.test(folded[j]) && !narration) {
          const parts = [clean(lines[j]).replace(/^[^:：]*[:：]/, "").trim()];
          for (let q = j + 1; q < end && !mask[q] && lines[q].trim() && !LABEL_RE.test(folded[q]); q++) parts.push(clean(lines[q]));
          narration = unquote(parts.filter(Boolean).join(" "));
        } else if (/^image\s*prompt/.test(folded[j]) && !imagePrompt) {
          imagePrompt = promptAfter(lines, j, end);
        }
      }
      return { number: s.number, narration, imagePrompt, hasVideo: false, videoPrompt: "" };
    });
  }

  /** A scene number written twice (a regenerated reply stays in the conversation): the latest version wins, at the first one's place. */
  function latestScenes(list, warnings) {
    const out = [], at = new Map(), dup = new Set();
    list.forEach((s) => {
      if (at.has(s.number)) { out[at.get(s.number)] = s; dup.add(s.number); return; }
      at.set(s.number, out.length);
      out.push(s);
    });
    dup.forEach((n) => warnings.push("Scene " + n + " appeared more than once. The latest version is used."));
    return out;
  }

  /** Line ranges of "Step N" sections. */
  function stepRegions(lines, mask) {
    const heads = [];
    lines.forEach((l, i) => {
      if (mask[i]) return;
      const f = fold(clean(l));
      const m = STEP_RE.exec(f);
      if (m) heads.push({ n: parseInt(m[1], 10), i });
      else if (REELS_HEAD_RE.test(f) && f.length < 80 && !(heads.length && heads[heads.length - 1].n === 6) && /^\s*(#|\*\*|__)/.test(l)) heads.push({ n: 6, i });
    });
    const out = {};
    heads.forEach((h, k) => {
      if (!out[h.n]) out[h.n] = [h.i + 1, k + 1 < heads.length ? heads[k + 1].i : lines.length];
    });
    return out;
  }

  function numbersIn(s) {
    return (toLatinDigits(s).match(/\d+/g) || []).map((x) => parseInt(x, 10));
  }

  /** Returns Map(sceneNumber -> videoPrompt) for the scenes picked in the step-4 section. */
  function parseVideo(lines, mask, region) {
    const result = new Map();
    if (!region) return result;
    const [from, to] = region;
    const folded = lines.map((l) => fold(clean(l)));
    const starts = [];
    for (let i = from; i < to; i++) {
      if (mask[i]) continue;
      const m = SCENE_ANY_RE.exec(folded[i]);
      if (m) starts.push({ i, number: parseInt(m[1], 10) });
      const list = /^(?:scenes?|animated scenes?|animations?|chosen scenes?|selected scenes?)[^:：]*[:：]\s*(.+)$/.exec(folded[i]);
      if (list && !m) numbersIn(list[1]).forEach((n) => { if (!result.has(n)) result.set(n, ""); });
    }
    starts.forEach((s, k) => {
      const end = k + 1 < starts.length ? starts[k + 1].i : to;
      let prompt = "";
      for (let j = s.i; j < end; j++) {
        if (!mask[j] && /video\s*prompt/.test(folded[j])) { prompt = promptAfter(lines, j, end); break; }
      }
      if (!result.get(s.number)) result.set(s.number, prompt);
    });
    return result;
  }

  /** Cover prompt written as plain text (same line as the label, or the lines under it). Fenced covers are caught by parseReels. */
  function coverAfter(lines, i, to, folded, mask) {
    const line = clean(lines[i]);
    const m = COVER_RE.exec(line);
    const rest = m ? line.slice(m[0].length).trim() : "";
    if (rest) return englishOnly(unquote(rest));
    const plain = [];
    for (let j = i + 1; j < to && plain.length < 6; j++) {
      if (mask[j] || LABEL_RE.test(folded[j]) || seoLabel(clean(lines[j]))) break;
      if (!lines[j].trim()) {
        if (plain.length) break;
        continue;
      }
      plain.push(clean(lines[j]));
    }
    return englishOnly(plain.join("\n"));
  }

  // Publishing text labels (colon optional when nothing follows). Persian labels are accepted too; digits after a label ("Caption 1:") are ignored.
  const SEO_NUM = "(?:\\s*[\\d\\u06f0-\\u06f9\\u0660-\\u0669]+)?";
  const SEO_TAIL = SEO_NUM + "\\s*(?:\\([^)]*\\))?\\s*(?:[:\\uff1a\\ufe55\\u2236]|$)";
  const SEO_RES = {
    coverHeadline: new RegExp("^(?:(?:reel|thumbnail|youtube|video)\\s*)?(?:cover\\s*(?:headline|title|text)|headline|\\u062a\\u06cc\\u062a\\u0631\\s*\\u06a9\\u0627\\u0648\\u0631|\\u0647\\u062f\\u0644\\u0627\\u06cc\\u0646(?:\\s*\\u06a9\\u0627\\u0648\\u0631)?)" + SEO_TAIL, "i"),
    title: new RegExp("^(?:youtube|video)\\s*title" + SEO_TAIL + "|^\\u0639\\u0646\\u0648\\u0627\\u0646\\s*(?:\\u06cc\\u0648\\u062a\\u06cc\\u0648\\u0628|\\u0648\\u06cc\\u062f\\u06cc\\u0648|\\u0648\\u06cc\\u062f\\u0626\\u0648)" + SEO_TAIL, "i"),
    caption: new RegExp("^(?:(?:reel|short|instagram|video|youtube)\\s*)?(?:caption|[\\u06a9\\u0643]\\u0627?\\u067e\\u0634\\u0646)" + SEO_TAIL, "i"),
  };
  const BOLD_LABEL_RE = /^\s*(?:[-*]\s+)?\*\*[^*\n]{1,60}?(?::\*\*|\*\*\s*:)/;

  /** Which publishing field a (cleaned) line labels, with the text after the label on the same line. */
  function seoLabel(line) {
    for (const kind of Object.keys(SEO_RES)) {
      const m = SEO_RES[kind].exec(line);
      if (m) return { kind, rest: line.slice(m[0].length).trim() };
    }
    return null;
  }

  /**
   * Cover Headline, YouTube Title and Caption in [from, to): the first of each. The value is the text after the label,
   * or a code block under it, or the lines under it up to the next label, heading, rule or code fence (blank lines inside
   * a caption are kept). Lines in `mask` are skipped. With skipIdeas, "Reel N:" idea blocks (step 5) are ignored until the next heading.
   */
  function parseSeo(lines, mask, from, to, skipIdeas) {
    const out = { coverHeadline: "", title: "", caption: "" };
    const folded = lines.map((l) => fold(clean(l)));
    const labelish = (j) => /^[^:\uff1a]{1,40}[:\uff1a]/.test(clean(lines[j])) &&
      (LABEL_RE.test(folded[j]) || COVER_RE.test(folded[j]) || SCENE_ANY_RE.test(folded[j]) || STEP_RE.test(folded[j]) || REEL_START_RE.test(folded[j]));
    const boundary = (j) => mask[j] || /^\s*#{1,6}\s/.test(lines[j]) || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[j]) ||
      BOLD_LABEL_RE.test(lines[j]) || !!seoLabel(clean(lines[j])) || labelish(j);
    let idea = false;
    for (let i = from; i < to; i++) {
      if (/^\s*#{1,6}\s/.test(lines[i])) idea = false;
      if (mask[i]) continue;
      if (skipIdeas && REEL_START_RE.test(folded[i])) idea = true;
      if (idea) continue;
      const lab = seoLabel(clean(lines[i]));
      if (!lab) continue;
      let text = lab.rest.replace(/\*\*|__/g, "");
      let end = i;
      if (!text) {
        const block = codeBlock(lines, i + 1, Math.min(to, i + 4));
        if (block !== null) {
          text = block;
          let o = i + 1;
          while (o < to && !/^\s*(```|~~~)/.test(lines[o])) o++;
          end = o + 1;
          while (end < to && !/^\s*(```|~~~)/.test(lines[end])) end++;
        }
      }
      if (!text || (!end || end === i)) {
        // Plain text: a caption runs through blank lines to the next label; a headline or title stops at the first blank line.
        const body = text ? [text] : [];
        for (let j = i + 1; j < to && !boundary(j); j++) {
          if (!lines[j].trim() && lab.kind !== "caption" && body.length) break;
          body.push(lines[j].replace(/\*\*|__/g, ""));
          end = j;
        }
        text = body.join("\n");
      }
      text = unquote(text.replace(/^\s*\n+|\n\s*$/g, "").trim());
      if (text && !out[lab.kind]) out[lab.kind] = text;
      i = Math.max(i, end);
    }
    return out;
  }

  /** Reels and Shorts package (Step 6): per reel an audio chunk, vertical image prompts, one or two animation prompts and a cover prompt. */
  function parseReels(lines, mask, region, startPhrase, warnings, ranges) {
    if (!region) return [];
    const [from, to] = region;
    const folded = lines.map((l) => fold(clean(l)));
    const heads = [];
    const seen = new Set();
    for (let i = from; i < to; i++) {
      if (mask[i]) continue;
      const m = REEL_START_RE.exec(folded[i]);
      if (!m) continue;
      const id = parseInt(m[1], 10);
      if (seen.has(id)) continue;
      seen.add(id);
      heads.push({ i, id });
    }
    return heads.map((h, k) => {
      const a = h.i + 1;
      const b = k + 1 < heads.length ? heads[k + 1].i : to;
      const name = "Reel " + String(h.id).padStart(2, "0");
      const chunk = parseChunks(lines, mask, startPhrase, a, b)[0];
      const audio = chunk ? { text: chunk.text, chars: chunk.chars } : null;
      const images = [];
      const videos = [];
      let cover = null;
      for (let at = a; at < b; at++) {
        if (!mask[at]) continue;
        // `at` is the opening fence of a code block; skip past its closing fence afterwards.
        const i = at;
        const fence = /^\s*(```|~~~)/.exec(lines[i]);
        let end = i + 1;
        while (end < b && !(fence && new RegExp("^\\s*" + fence[1]).test(lines[end]))) end++;
        at = end;
        let kind = "", num = 0, narration = "", label = "";
        for (let j = i - 1; j >= Math.max(a, i - 8) && !mask[j]; j--) {
          const f = folded[j];
          if (!f) continue;
          if (!kind) {
            if (COVER_RE.test(f)) kind = "cover";
            else if (/^(?:vertical\s+)?(?:video|animation|flow|\u0627\u0646\u06CC\u0645\u06CC\u0634\u0646|\u0648\u06CC\u062F\u06CC\u0648|\u0648\u06CC\u062F\u0626\u0648)/.test(f)) kind = "video";
            else if (/^(?:vertical\s+)?(?:image|scene|shot|\u062A\u0635\u0648\u06CC\u0631|\u0635\u062D\u0646\u0647|\u0634\u0627\u062A)/.test(f)) kind = "image";
          }
          const nm = /^(?:image|scene|shot|\u062A\u0635\u0648\u06CC\u0631|\u0635\u062D\u0646\u0647|\u0634\u0627\u062A)\s*(?:number|prompt|\u0634\u0645\u0627\u0631\u0647)?\s*[:#\[]?\s*(\d+)/.exec(f);
          if (nm && !num) num = parseInt(nm[1], 10);
          // "Reel Scene Number: [R01-01]" names the image outright.
          const rl = /^reel\s*(?:scene|image|shot)\s*(?:number|no\.?|#)?\s*[:#]?\s*\[?\s*r?\s*(\d+)\s*[-_]\s*(\d+)\s*\]?/.exec(f);
          if (rl && !label) { label = "R" + String(parseInt(rl[1], 10)).padStart(2, "0") + "-" + String(parseInt(rl[2], 10)).padStart(2, "0"); if (!num) num = parseInt(rl[2], 10); }
          const nr = /^(?:narration(?:\s*part)?|\u0631\u0648\u0627\u06CC\u062A|\u06AF\u0641\u062A\u0627\u0631)\s*[:：]\s*(.+)$/.exec(f);
          if (nr && !narration) narration = unquote(clean(lines[j]).replace(/^[^:：]*[:：]/, ""));
        }
        const body = codeBlock(lines, i, Math.min(b, i + 41));
        const prompt = body === null ? "" : englishOnly(body);
        if (!prompt) continue;
        if (kind === "cover") { if (!cover) cover = { prompt }; continue; }
        if (kind === "video") videos.push({ prompt });
        else {
          const n = num || images.length + 1;
          images.push({ n, label: label || "R" + String(h.id).padStart(2, "0") + "-" + String(n).padStart(2, "0"), narration, prompt });
        }
      }
      if (!videos.length) {
        for (let i = a; i < b; i++) {
          if (!mask[i] && /^(?:vertical\s+)?(?:video|animation|flow)\s*prompt/.test(folded[i])) {
            const prompt = promptAfter(lines, i, b);
            if (prompt) videos.push({ prompt });
          }
        }
      }
      if (!cover) {
        for (let i = a; i < b && !cover; i++) {
          if (mask[i] || !COVER_RE.test(folded[i])) continue;
          const prompt = coverAfter(lines, i, b, folded, mask);
          if (prompt) cover = { prompt };
        }
      }
      const video = videos[0] || null;
      const seo = parseSeo(lines, mask, a, b);
      if (ranges) ranges.push([h.i, b]);
      if (!cover) warnings.push(name + " has no Reel Cover Prompt.");
      if (!audio) warnings.push(name + " has no audio chunk. Check the start phrase in the settings.");
      if (images.length < 3 || images.length > 4) warnings.push(name + " has " + images.length + " image prompt(s); 3 to 4 are expected.");
      if (!video) warnings.push(name + " has no vertical animation prompt.");
      return { id: h.id, name, audio, images, video, videos, cover, coverHeadline: seo.coverHeadline, caption: seo.caption };
    });
  }

  /** Thumbnail prompt of the step 5 section (the old reel cut ideas are no longer parsed). */
  function parseViral(lines, mask, region) {
    const [from, to] = region || [0, lines.length];
    const folded = lines.map((l) => fold(clean(l)));
    const reelRe = /^reel\s*(?:number|#)?\s*[:\[]?\s*(\d+)\s*\]?\s*[:\-.\u2013\u2014]?\s*(.*)$/;
    const reelAt = [];
    for (let i = from; i < to; i++) {
      if (mask[i]) continue;
      const m = reelRe.exec(folded[i]);
      if (m) reelAt.push({ i, number: parseInt(m[1], 10) });
    }
    const firstReel = reelAt.length ? reelAt[0].i : to;
    let thumbnail = null;
    for (let i = from; i < firstReel; i++) {
      if (!mask[i] && /thumbnail/.test(folded[i]) && codeBlock(lines, i + 1, Math.min(firstReel, i + 8)) !== null) {
        thumbnail = { prompt: promptAfter(lines, i, firstReel) };
        break;
      }
    }
    return { thumbnail };
  }

  /**
   * Parse a pasted conversation.
   * options.startPhrase: text that opens every audio chunk (default: the demo phrase; /app passes the one saved in Setup).
   */
  function parse(text, options) {
    const opts = options || {};
    const startPhrase = opts.startPhrase === undefined ? DEFAULT_START_PHRASE : opts.startPhrase;
    const lines = normalize(text).split("\n");
    const mask = fenceMask(lines);
    const warnings = [];

    const regions = stepRegions(lines, mask);
    // The Reels and Shorts section (step 6) keeps its own audio, images and animation apart from the main video.
    const chunks = parseChunks(lines, mask, startPhrase, 0, regions[6] ? regions[6][0] : lines.length);
    // Scene headers in the step 4 to 6 sections belong to video prompts and reels, not image scenes.
    const sceneMask = mask.slice();
    [4, 5, 6].forEach((n) => {
      if (regions[n]) for (let i = regions[n][0]; i < regions[n][1]; i++) sceneMask[i] = true;
    });
    const scenes = latestScenes(parseScenes(lines, sceneMask), warnings);
    const video = parseVideo(lines, mask, regions[4]);
    video.forEach((prompt, number) => {
      const scene = scenes.find((s) => s.number === number);
      if (!scene) return warnings.push("Video scene " + number + " has no matching image scene.");
      scene.hasVideo = true;
      scene.videoPrompt = prompt;
      if (!prompt) warnings.push("Scene " + number + " is marked for animation but no Video Prompt was found.");
    });
    const viral = parseViral(lines, mask, regions[5] || [0, regions[6] ? regions[6][0] : lines.length]);
    const reelRanges = [];
    const reels = parseReels(lines, mask, regions[6], startPhrase, warnings, reelRanges);
    // Publishing text outside the reel blocks belongs to the main video (a top-level Caption is the video caption).
    const seoMask = mask.slice();
    reelRanges.forEach(([a, b]) => { for (let i = a; i < b; i++) seoMask[i] = true; });
    const seo = parseSeo(lines, seoMask, 0, lines.length, true);

    if (String(text || "").trim() && !chunks.length) warnings.push("No audio chunks found. Set the chunk start phrase in step 1.");
    scenes.forEach((s) => {
      if (!s.imagePrompt) warnings.push("Scene " + s.number + " has no Image Prompt.");
    });

    return {
      chunks,
      scenes,
      thumbnail: viral.thumbnail,
      coverHeadline: seo.coverHeadline,
      youtubeTitle: seo.title,
      caption: seo.caption,
      reels,
      warnings,
      stats: {
        audioChunks: chunks.length,
        imageScenes: scenes.length,
        animations: scenes.filter((s) => s.hasVideo).length,
        reels: reels.length,
        reelAudio: reels.filter((r) => r.audio).length,
      },
    };
  }

  /**
   * Split the configured warm-up start phrase off the front of a text, tolerant of
   * ZWNJ, digit and letter-form differences. Returns { warm, rest }; warm is "" when absent.
   * warm + rest always equals the input.
   */
  function splitWarmup(text, phrase) {
    text = String(text == null ? "" : text);
    const want = fold(phrase || "");
    if (!want) return { warm: "", rest: text };
    const lead = /^\s*/.exec(text)[0].length;
    const max = Math.min(text.length, lead + want.length * 2 + 12);
    for (let i = lead + 1; i <= max; i++) {
      if (fold(text.slice(lead, i)) !== want) continue;
      const tail = /^[\s.,;:!?\u060c\u061b\u061f\u2026\-\u2013\u2014]*/.exec(text.slice(i))[0].length;
      return { warm: text.slice(0, i + tail), rest: text.slice(i + tail) };
    }
    return { warm: "", rest: text };
  }

  return { parse, splitWarmup, detectLanguage, isRtlLang, toLatinDigits, fold, englishOnly, DEFAULT_START_PHRASE, RTL_LANGS };
});
