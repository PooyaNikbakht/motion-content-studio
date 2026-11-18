/*
 * The in-app guide ("How to use Motion Content Studio"): one numbered section per step, each with three parts.
 * All wording lives in the GUIDE data object below, so it can be edited in one place. The "Recommended" parts are suggestions
 * (labelled as such), not rules. html(opts) returns the dialog body; no DOM access, no network.
 * UMD: window.MBSGuide in the browser, require() in Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MBSGuide = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const GUIDE = {
    title: "How to use Motion Content Studio",
    start: "First time here? Go to Setup first (keys and the Master Prompt), then open Import & Parse to create the book package. The other tabs fill in from there. In the real app your project lives on the server and is loaded from it each time you open it: press Save (Ctrl or Cmd+S) to keep your edits. Parse, file uploads and each director reply are saved right away.",
    labels: { app: "What the app does here", you: "What you do in other tools", rec: "Recommended for this step" },
    recNote: "Suggestions, not rules. Use what works for your channel.",
    steps: [
      {
        id: "setup", tab: "setup", title: "Setup",
        app: "Stores your Gemini key and model routing (which Gemini model runs which of the 6 stages), your ElevenLabs key with its model and rates, the output folder for audio, and your Master Director Prompt. Keys stay in this browser, and on Setup the top save bar saves them. Setup also shows cost estimates before you run anything.",
        you: "Create a Gemini API key in Google AI Studio and an ElevenLabs API key in your ElevenLabs account. Write or paste your Master Director Prompt (the instructions the AI director follows).",
        rec: [
          "Gemini routing: Gemini 3.8 Flash for the cheap bulk stages (3 to 6), 4 Carbon for the stages where quality matters most (1 architecture and 2 script). The Recommended Smart Hybrid preset does this.",
          "Eleven v4: recommended for Persian narration and expressive storytelling (pairs with the 3-sentence Persian warm-up your Master Prompt puts at the start of each chunk). Eleven v3 is the previous-generation alternative (audio tags, 5,000 character limit).",
          "Eleven Flash v2.5: best for English production (fast, natural, about 50% lower cost, no warm-up sentences needed).",
          "Multilingual v2: alternative for longer, ultra-stable narration blocks.",
          "Our Master Prompt slices audio into about 800 to 900 character chunks (under 1,000 characters) for maximum voice stability, well below each model's hard API cap (5,000 for v3, 10,000 for v4 and Multilingual v2, 40,000 for Flash v2.5). Chunks over the cap of the chosen model are flagged.",
        ],
        demo: "In the demo nothing is sent anywhere: the director and the audio are simulated, so no keys are needed and the Master Prompt shown is a short fictional sample.",
      },
      {
        id: "import", tab: "import", title: "Import & Parse",
        app: "AI Director mode runs your Master Prompt on Gemini for you: choose the language, add the book PDF or a title, then Start Project and Next Step through the 6 stages, or Auto-Run all of them. Each reply is parsed into the project as it arrives. Paste Conversation mode takes a chat you ran yourself and splits it into audio chunks, 16:9 scenes, Flow animations, covers, publishing text and 9:16 reels, with counts to check.",
        you: "Nothing is required for AI Director. For Paste Conversation, run the Master Prompt in a Gemini chat, answer \"Continue\" at each checkpoint, then paste the whole conversation here.",
        rec: [
          "Use AI Director for most books: it keeps the cost visible and lets you give feedback, regenerate or edit a reply at any stage.",
          "Turn on Pause after each stage while you are learning the flow, and read each stage before continuing.",
          "Use Paste Conversation when you already have a finished chat or want to work in Gemini directly.",
        ],
        demo: "The demo plays a canned fictional conversation in about 8 replies, with made-up token counts and costs.",
      },
      {
        id: "audio", tab: "youtube/audio", title: "YouTube Audio",
        app: "Turns every audio chunk of the main video into a numbered narration file with ElevenLabs (01_audio.mp3, 02_audio.mp3 and so on), with a queue, retries, quality checks and a cost estimate. Files can be saved to a folder or downloaded as a ZIP.",
        you: "Listen to a few chunks. If a voice or model does not suit the book, change it in Setup and regenerate those chunks.",
        rec: [
          "Generate one or two chunks first, listen, then queue the rest.",
          "Keep chunks under the per-request limit of your model (5,000 for v3, 10,000 for v4 and Multilingual v2, or 40,000 for Flash v2.5).",
          "For Persian projects on Eleven v4 or v3, keep the 3-sentence warm-up in each chunk for a stable voice tone. The app dims it in the text (Setup, Dim warm-up phrase) so you can cut it in your audio editor; it does not trim it for you.",
        ],
        demo: "The demo generates short placeholder tones, not speech, and makes no ElevenLabs calls.",
      },
      {
        id: "board", tab: "youtube/board", title: "Visual Board",
        app: "Shows one card per 16:9 scene with its narration, image prompt and, for Flow scenes, video prompt. Copy a prompt with the small copy icon beside its label, then upload the finished image or video into the slot on the card. Tick progress as you go. In the real app uploads are stored on your account (R2) and open in a lightbox.",
        you: "Generate each image from its prompt in your image tool, and each animation clip from its video prompt in Flow. Download the results and upload them to the card.",
        rec: [
          "Images: any Gemini or Imagen-class image tool of your choice. Keep one style across the whole video.",
          "Animation: Flow for clips made from the video prompts.",
          "Work scene by scene and tick each card, so the progress meters show what is left.",
          "All image prompts use universal 2 to 4 word English title banners, so you can reuse the exact same generated images and Flow clips for both your English and Persian channels.",
        ],
        demo: "In the demo uploaded files stay in your browser and are not saved to any server.",
      },
      {
        id: "cover", tab: "youtube/covers", title: "Cover & SEO",
        app: "Holds the 16:9 cover prompt, the cover headline, the YouTube title and the caption for the main video, each with copy and an upload slot for the finished cover.",
        you: "Generate the thumbnail in your image tool, then paste the title and caption into YouTube Studio when you publish.",
        rec: [
          "Generate two or three cover variants and pick the one that reads best at small size.",
          "Check that the headline is readable on a phone screen.",
        ],
      },
      {
        id: "reels", tab: "reels", title: "Reels (9:16)",
        app: "One tab per reel, each with its audio, vertical images, Flow animations, cover prompt, headline and caption. The same copy icons, upload slots and progress ticks as the 16:9 workflow.",
        you: "Generate the vertical images and clips in the same tools as the main video, and produce each reel's audio.",
        rec: [
          "Keep the visual style of the reels the same as the main video so the channel looks consistent.",
          "Publish reels as YouTube Shorts (or your short-video platform of choice) with the caption provided.",
        ],
      },
      {
        id: "assemble", tab: "overview", title: "Assemble and publish",
        app: "Download all assets from the Files panel on the Overview tab: Audio/, Images/, Video/ and Reels/Reel_01/... folders plus edit-list.csv, which lists the order, scene, chunk, audio, image and video for every item.",
        you: "Assemble the video in your editor, following edit-list.csv for the order. Export, then upload to YouTube Studio (and Shorts for the reels).",
        rec: [
          "Any editor works: CapCut, DaVinci Resolve or Premiere. Import the folders and place clips in the order of edit-list.csv.",
          "In CapCut (or your editor), apply a subtle slow Ken Burns zoom to static images, and stretch locked-off Flow animations using 0.5x speed (Optical Flow) or a reverse loop to cover 30 to 40 second narration beats.",
          "Upload with YouTube Studio, using the title, caption and cover from the Cover & SEO tab.",
        ],
        demo: "In the demo the download contains only the placeholder audio and the files you uploaded in this browser.",
      },
    ],
  };

  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const find = (id) => GUIDE.steps.find((s) => s.id === id) || null;

  /** Dialog body. opts: { demo }. Each section has id "guide-<step id>" so the tabs can scroll to it. */
  function html(opts) {
    const demo = !!(opts && opts.demo);
    const toc = '<nav class="guide-toc" aria-label="Guide steps"><ol>' + GUIDE.steps.map((s) => '<li><a href="#guide-' + s.id + '" data-guide-go="' + s.id + '">' + esc(s.title) + "</a></li>").join("") + "</ol></nav>";
    const body = GUIDE.steps.map((s, i) =>
      '<section class="guide-sec" id="guide-' + s.id + '" aria-labelledby="guide-h-' + s.id + '" tabindex="-1">' +
      '<h3 id="guide-h-' + s.id + '"><span class="guide-n" aria-hidden="true">' + (i + 1) + "</span>" + esc(s.title) + "</h3>" +
      '<h4>' + esc(GUIDE.labels.app) + "</h4><p>" + esc(s.app) + "</p>" +
      '<h4>' + esc(GUIDE.labels.you) + "</h4><p>" + esc(s.you) + "</p>" +
      '<h4>' + esc(GUIDE.labels.rec) + ' <span class="badge plain">Suggestion</span></h4><ul>' + s.rec.map((r) => "<li>" + esc(r) + "</li>").join("") + "</ul>" +
      (s.id === "import" ? '<p><a class="btn sm" id="guide-format" data-fmt href="/format">Open format guide</a></p>' : "") +
      (demo && s.demo ? '<p class="hint guide-demo"><strong>In the demo:</strong> ' + esc(s.demo) + "</p>" : "") +
      "</section>").join("");
    return '<div class="guide-start" role="note"><strong>Where to start</strong><p>' + esc(GUIDE.start) + "</p></div>" +
      '<p class="hint">' + esc(GUIDE.recNote) + "</p>" + toc + body;
  }

  return { GUIDE, find, html };
});
