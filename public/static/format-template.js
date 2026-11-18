/*
 * Minimal input template for the Input format guide. The guide page and tests/format.test.js share this file,
 * and the test parses it with the real parser, so the documented shape cannot drift from what the parser reads.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MBSTemplate = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** What parsing buildTemplate() must produce (checked in tests/format.test.js). */
  const EXPECTED = { audioChunks: 2, imageScenes: 2, animations: 1, reels: 1, reelAudio: 1, thumbnail: true, warnings: 0 };

  /** A short skeleton with placeholders. Every chunk and reel audio starts with the start phrase. */
  function buildTemplate(startPhrase) {
    const sp = startPhrase;
    return [
      "## Step 1: Audio script", "",
      "**Audio chunk 1**", "",
      sp + ". [Narration for chunk 1 goes here.]", "",
      "---", "",
      "**Audio chunk 2**", "",
      sp + ". [Narration for chunk 2 goes here.]", "",
      "---", "",
      "## Step 2: Image scenes", "",
      "**Scene Number: [01]**",
      '**Narration Part:** "[The sentence this scene shows]"',
      "**Image Prompt:**",
      "```", "[English image prompt for scene 1]", "```", "",
      "**Scene Number: [02]**",
      '**Narration Part:** "[The sentence this scene shows]"',
      "**Image Prompt:**",
      "```", "[English image prompt for scene 2]", "```", "",
      "## Step 4: Flow animation", "",
      "Scenes chosen for animation: 02", "",
      "**Scene Number: [02]**",
      "**Video Prompt:**",
      "```", "[English animation prompt for scene 2]", "```", "",
      "## Step 5: Thumbnail and publishing text", "",
      "**Thumbnail Prompt:**",
      "```", "[English prompt for the 16:9 YouTube cover]", "```", "",
      '**Cover Headline:** "[Short headline on the cover]"', "",
      "**YouTube Title:** [Video title]", "",
      "**Caption:** [Video caption]", "#[hashtag] #[hashtag]", "",
      "## Step 6: Reels and Shorts (9:16)", "",
      "### Reel 01", "",
      "**Audio chunk**", "",
      sp + ". [Narration for the reel goes here.]", "",
    ].concat([1, 2, 3].reduce((acc, n) => acc.concat([
      "**Reel Scene Number: [R01-0" + n + "]**",
      '**Narration Part:** "[The sentence this vertical image shows]"',
      "**Image Prompt:**",
      "```", "Vertical 9:16, [English image prompt for reel scene " + n + "]", "```", "",
    ]), [])).concat([
      "**Video Prompt (Flow 9:16):**",
      "```", "Vertical 9:16, [English animation prompt for the reel]", "```", "",
      "**Reel Cover Prompt:**",
      "```", "Vertical 9:16 reel cover, [English cover prompt]", "```", "",
      '**Cover Headline:** "[Reel cover headline]"', "",
      "**Caption:** [Reel caption]", "#[hashtag] #[hashtag]", "",
    ]).join("\n");
  }

  return { buildTemplate, EXPECTED };
});
