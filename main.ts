import { CheckIf } from "checkif";
import { EditorExtensions } from "editor-enhancements";
import { Editor, Plugin, Notice } from "obsidian";
import getPageTitle from "scraper";
import getElectronPageTitle from "electron-scraper";
import {
  AutoLinkTitleSettingTab,
  AutoLinkTitleSettings,
  DEFAULT_SETTINGS,
} from "./settings";

// Import Node's child_process (only available in the Desktop/Electron environment)
import { execSync } from "child_process";

// Helper to check and run the gh CLI for GitHub pull requests.
// Given a URL like "https://github.com/owner/repo/pull/123",
// it extracts the owner, repo, and PR number, then executes a gh command
// to fetch the PR title in JSON format.
async function getGithubPRTitle(url: string): Promise<string> {
  const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
  if (!match) return url;

  const owner = match[1];
  const repo = match[2];
  const prNumber = match[3];

  try {
    // Use gh CLI to get the PR title.
    // The command below returns just the title using the --jq option.
    const env = {
      ...process.env,
      PATH: process.env.PATH + ":/opt/homebrew/bin"
    };
    const output = execSync(
      `gh pr view ${prNumber} --repo ${owner}/${repo} --json title --jq .title`,
      { encoding: "utf8", env }
    );
    var prTitle = output.trim();
    var prTitle = `${prTitle} · ${owner}/${repo}#${prNumber}`;
    return prTitle;
  } catch (err) {
    console.error("gh command failed:", err);
    return url;
  }
}

interface PasteFunction {
  (this: HTMLElement, ev: ClipboardEvent): void;
}

interface DropFunction {
  (this: HTMLElement, ev: DragEvent): void;
}

export default class AutoLinkTitle extends Plugin {
  settings: AutoLinkTitleSettings;
  pasteFunction: PasteFunction;
  dropFunction: DropFunction;
  blacklist: Array<string>;

  async onload() {
    console.log("loading obsidian-auto-link-title");
    await this.loadSettings();

    this.blacklist = this.settings.websiteBlacklist
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // Listen to paste event
    this.pasteFunction = this.pasteUrlWithTitle.bind(this);

    // Listen to drop event
    this.dropFunction = this.dropUrlWithTitle.bind(this);

    this.addCommand({
      id: "auto-link-title-paste",
      name: "Paste URL and auto fetch title",
      editorCallback: (editor) => this.manualPasteUrlWithTitle(editor),
      hotkeys: [],
    });

    this.addCommand({
      id: "auto-link-title-normal-paste",
      name: "Normal paste (no fetching behavior)",
      editorCallback: (editor) => this.normalPaste(editor),
      hotkeys: [
        {
          modifiers: ["Mod", "Shift"],
          key: "v",
        },
      ],
    });

    this.registerEvent(
      this.app.workspace.on("editor-paste", this.pasteFunction)
    );

    this.registerEvent(this.app.workspace.on("editor-drop", this.dropFunction));

    this.addCommand({
      id: "enhance-url-with-title",
      name: "Enhance existing URL with link and title",
      editorCallback: (editor) => this.addTitleToLink(editor),
      hotkeys: [
        {
          modifiers: ["Mod", "Shift"],
          key: "e",
        },
      ],
    });

    this.addCommand({
      id: "insert-github-recent-authored-prs",
      name: "Insert recently authored GitHub PRs",
      editorCallback: (editor) => this.insertGithubRecentAuthoredPRs(editor),
      hotkeys: [
        {
          modifiers: ["Mod", "Shift"],
          key: "g",
        },
      ],
    });

    this.addCommand({
      id: "insert-github-recent-involved-prs",
      name: "Insert recent GitHub PRs I was involved in",
      editorCallback: (editor) => this.insertGithubRecentInvolvedPRs(editor),
      hotkeys: [
        {
          modifiers: ["Mod", "Shift"],
          key: "i",
        },
      ],
    });


    this.addSettingTab(new AutoLinkTitleSettingTab(this.app, this));
  }

  insertGithubRecentInvolvedPRs(editor: Editor): void {
    // Only attempt fetch if online
    if (!navigator.onLine) {
      new Notice("No internet connection. Cannot fetch GitHub PRs.");
      return;
    }
    try {
      // Add common directories to PATH so that gh is found.
      const env = {
        ...process.env,
        PATH: process.env.PATH + ":/opt/homebrew/bin"
      };
      // Query for PRs authored by me
      const authoredCommand = 'gh search prs --author=@me --updated ">=$(date -u -v-18H +%Y-%m-%dT%H:%M:%SZ)" --json number,title,updatedAt,url --limit 50';
      const authoredOutput = execSync(authoredCommand, { encoding: "utf8", env });
      const authoredPRs: any[] = JSON.parse(authoredOutput);

      // Query for PRs I'm involved in (as reviewer or otherwise)
      const involvedCommand = 'gh search prs --involves @me --updated ">=$(date -u -v-18H +%Y-%m-%dT%H:%M:%SZ)" --json number,title,updatedAt,url --limit 50';
      const involvedOutput = execSync(involvedCommand, { encoding: "utf8", env });
      const involvedPRs: any[] = JSON.parse(involvedOutput);

      // Use a set to filter out any PRs from involvedPRs that are already in authoredPRs.
      const authoredUrls = new Set(authoredPRs.map(pr => pr.url));
      const reviewPRs = involvedPRs.filter(pr => !authoredUrls.has(pr.url));

      // Helper function to format a list of PRs into Markdown.
      const formatPRs = (prs: any[]): string => {
        return prs.map(pr => {
          try {
            const urlObj = new URL(pr.url);
            const parts = urlObj.pathname.split("/");
            const owner = parts[1] || "";
            const repo = parts[2] || "";
            return `- [${pr.title} · ${owner}/${repo}#${pr.number}](${pr.url})`;
          } catch (error) {
            return `- [${pr.title} #${pr.number}](${pr.url})`;
          }
        }).join("\n");
      };

      const authoredList = formatPRs(authoredPRs);
      const reviewList = formatPRs(reviewPRs);

      // Combine into two sections with headers.
      const markdown =
        `### PRs
${authoredList}

### Reviews
${reviewList}`;

      editor.replaceSelection(markdown);
    } catch (err) {
      console.error("gh command failed:", err);
      new Notice("Failed to fetch GitHub PRs.");
    }
  }

  insertGithubRecentAuthoredPRs(editor: Editor): void {
    // Only attempt fetch if online
    if (!navigator.onLine) {
      new Notice("No internet connection. Cannot fetch GitHub PRs.");
      return;
    }
    try {
      // Execute gh CLI to search for recent PRs by me updated in the last ~18 hours.
      const command = 'gh search prs --author=@me --updated ">=$(date -u -v-18H +%Y-%m-%dT%H:%M:%SZ)" --json number,title,updatedAt,url --limit 50';
      const env = {
        ...process.env,
        PATH: process.env.PATH + ":/opt/homebrew/bin"
      };
      const output = execSync(command, { encoding: "utf8", env });
      const prs = JSON.parse(output);
      if (!Array.isArray(prs) || prs.length === 0) {
        new Notice("No recent PRs found.");
        return;
      }
      // Format each PR into a Markdown bullet list item.
      const prList = prs.map((pr: any) => {
        try {
          const urlObj = new URL(pr.url);
          // Expected pathname is in the form /owner/repo/pull/number.
          const parts = urlObj.pathname.split("/");
          const owner = parts[1] || "";
          const repo = parts[2] || "";
          return `- [${pr.title} · ${owner}/${repo}#${pr.number}](${pr.url})`;
        } catch (error) {
          // Fallback formatting if URL parsing fails.
          return `- [${pr.title} #${pr.number}](${pr.url})`;
        }
      }).join("\n");
      // Insert the markdown list at the current cursor position.
      editor.replaceSelection(prList);
    } catch (err) {
      console.error("gh command failed:", err);
      new Notice("Failed to fetch recent PRs.");
    }
  }

  addTitleToLink(editor: Editor): void {
    // Only attempt fetch if online

    let selectedText = (EditorExtensions.getSelectedText(editor) || "").trim();

    // If the cursor is on a raw html link, convert to a markdown link and fetch title
    if (CheckIf.isUrl(selectedText)) {
      this.convertUrlToTitledLink(editor, selectedText);
    }

    if (!navigator.onLine) {
      new Notice("No internet connection. Cannot fetch title.");
      return;
    }

    // If the cursor is on the URL part of a markdown link, fetch title and replace existing link title
    else if (CheckIf.isLinkedUrl(selectedText)) {
      const link = this.getUrlFromLink(selectedText);
      this.convertUrlToTitledLink(editor, link);
    }
  }

  async normalPaste(editor: Editor): Promise<void> {
    let clipboardText = await navigator.clipboard.readText();
    if (clipboardText === null || clipboardText === "") return;

    editor.replaceSelection(clipboardText);
  }

  // Simulate standard paste but using editor.replaceSelection with clipboard text since we can't seem to dispatch a paste event.
  async manualPasteUrlWithTitle(editor: Editor): Promise<void> {
    const clipboardText = await navigator.clipboard.readText();

    // Only attempt fetch if online
    if (!navigator.onLine) {
      editor.replaceSelection(clipboardText);
      new Notice("No internet connection. Cannot fetch title.");
      return;
    }

    if (clipboardText == null || clipboardText == "") return;

    // If its not a URL, we return false to allow the default paste handler to take care of it.
    // Similarly, image urls don't have a meaningful <title> attribute so downloading it
    // to fetch the title is a waste of bandwidth.
    if (!CheckIf.isUrl(clipboardText) || CheckIf.isImage(clipboardText)) {
      editor.replaceSelection(clipboardText);
      return;
    }

    // If it looks like we're pasting the url into a markdown link already, don't fetch title
    // as the user has already probably put a meaningful title, also it would lead to the title
    // being inside the link.
    if (CheckIf.isMarkdownLinkAlready(editor) || CheckIf.isAfterQuote(editor)) {
      editor.replaceSelection(clipboardText);
      return;
    }

    // If url is pasted over selected text and setting is enabled, no need to fetch title,
    // just insert a link
    let selectedText = (EditorExtensions.getSelectedText(editor) || "").trim();
    if (selectedText && this.settings.shouldPreserveSelectionAsTitle) {
      editor.replaceSelection(`[${selectedText}](${clipboardText})`);
      return;
    }

    // At this point we're just pasting a link in a normal fashion, fetch its title.
    this.convertUrlToTitledLink(editor, clipboardText);
    return;
  }

  async pasteUrlWithTitle(
    clipboard: ClipboardEvent,
    editor: Editor
  ): Promise<void> {
    if (!this.settings.enhanceDefaultPaste) {
      return;
    }

    if (clipboard.defaultPrevented) return;

    let clipboardText = clipboard.clipboardData.getData("text/plain");
    if (clipboardText === null || clipboardText === "") return;

    // If its not a URL, we return false to allow the default paste handler to take care of it.
    // Similarly, image urls don't have a meaningful <title> attribute so downloading it
    // to fetch the title is a waste of bandwidth.
    if (!CheckIf.isUrl(clipboardText) || CheckIf.isImage(clipboardText)) {
      return;
    }

    // Only attempt fetch if online
    if (!navigator.onLine) {
      new Notice("No internet connection. Cannot fetch title.");
      return;
    }

    // We've decided to handle the paste, stop propagation to the default handler.
    clipboard.stopPropagation();
    clipboard.preventDefault();

    // If it looks like we're pasting the url into a markdown link already, don't fetch title
    // as the user has already probably put a meaningful title, also it would lead to the title
    // being inside the link.
    if (CheckIf.isMarkdownLinkAlready(editor) || CheckIf.isAfterQuote(editor)) {
      editor.replaceSelection(clipboardText);
      return;
    }

    // If url is pasted over selected text and setting is enabled, no need to fetch title,
    // just insert a link
    let selectedText = (EditorExtensions.getSelectedText(editor) || "").trim();
    if (selectedText && this.settings.shouldPreserveSelectionAsTitle) {
      editor.replaceSelection(`[${selectedText}](${clipboardText})`);
      return;
    }

    // At this point we're just pasting a link in a normal fashion, fetch its title.
    this.convertUrlToTitledLink(editor, clipboardText);
    return;
  }

  async dropUrlWithTitle(dropEvent: DragEvent, editor: Editor): Promise<void> {
    if (!this.settings.enhanceDropEvents) {
      return;
    }

    if (dropEvent.defaultPrevented) return;

    let dropText = dropEvent.dataTransfer.getData("text/plain");
    if (dropText === null || dropText === "") return;

    // If its not a URL, we return false to allow the default paste handler to take care of it.
    // Similarly, image urls don't have a meaningful <title> attribute so downloading it
    // to fetch the title is a waste of bandwidth.
    if (!CheckIf.isUrl(dropText) || CheckIf.isImage(dropText)) {
      return;
    }
    // Only attempt fetch if online
    if (!navigator.onLine) {
      new Notice("No internet connection. Cannot fetch title.");
      return;
    }

    // We've decided to handle the paste, stop propagation to the default handler.
    dropEvent.stopPropagation();
    dropEvent.preventDefault();

    // If it looks like we're pasting the url into a markdown link already, don't fetch title
    // as the user has already probably put a meaningful title, also it would lead to the title
    // being inside the link.
    if (CheckIf.isMarkdownLinkAlready(editor) || CheckIf.isAfterQuote(editor)) {
      editor.replaceSelection(dropText);
      return;
    }

    // If url is pasted over selected text and setting is enabled, no need to fetch title,
    // just insert a link
    let selectedText = (EditorExtensions.getSelectedText(editor) || "").trim();
    if (selectedText && this.settings.shouldPreserveSelectionAsTitle) {
      editor.replaceSelection(`[${selectedText}](${dropText})`);
      return;
    }

    // At this point we're just pasting a link in a normal fashion, fetch its title.
    this.convertUrlToTitledLink(editor, dropText);
    return;
  }

  async isBlacklisted(url: string): Promise<boolean> {
    await this.loadSettings();
    this.blacklist = this.settings.websiteBlacklist
      .split(/,|\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return this.blacklist.some((site) => url.includes(site));
  }

  async convertUrlToTitledLink(editor: Editor, url: string): Promise<void> {
    if (await this.isBlacklisted(url)) {
      let domain = new URL(url).hostname;
      editor.replaceSelection(`[${domain}](${url})`);
      return;
    }

    // Generate a unique id for find/replace operations for the title.
    const pasteId = this.getPasteId();

    // Instantly paste so you don't wonder if paste is broken
    editor.replaceSelection(`[${pasteId}](${url})`);

    // Fetch title from site, replace Fetching Title with actual title
    const title = await this.fetchUrlTitle(url);
    const escapedTitle = this.escapeMarkdown(title);
    const shortenedTitle = this.shortTitle(escapedTitle);

    const text = editor.getValue();

    const start = text.indexOf(pasteId);
    if (start < 0) {
      console.log(
        `Unable to find text "${pasteId}" in current editor, bailing out; link ${url}`
      );
    } else {
      const end = start + pasteId.length;
      const startPos = EditorExtensions.getEditorPositionFromIndex(text, start);
      const endPos = EditorExtensions.getEditorPositionFromIndex(text, end);

      editor.replaceRange(shortenedTitle, startPos, endPos);
    }
  }

  escapeMarkdown(text: string): string {
    var unescaped = text.replace(/\\(\*|_|`|~|\\|\[|\])/g, "$1"); // unescape any "backslashed" character
    var escaped = unescaped.replace(/(\*|_|`|<|>|~|\\|\[|\])/g, "\\$1"); // escape *, _, `, ~, \, [, ], <, and >
    var escaped = unescaped.replace(/(\*|_|`|\||<|>|~|\\|\[|\])/g, "\\$1"); // escape *, _, `, ~, \, |, [, ], <, and >
    return escaped;
  }

  public shortTitle = (title: string): string => {
    if (this.settings.maximumTitleLength === 0) {
      return title;
    }
    if (title.length < this.settings.maximumTitleLength + 3) {
      return title;
    }
    const shortenedTitle = `${title.slice(
      0,
      this.settings.maximumTitleLength
    )}...`;
    return shortenedTitle;
  };

  public async fetchUrlTitleViaLinkPreview(url: string): Promise<string> {
    if (this.settings.linkPreviewApiKey.length !== 32) {
      console.error(
        "LinkPreview API key is not 32 characters long, please check your settings"
      );
      return "";
    }

    try {
      const apiEndpoint = `https://api.linkpreview.net/?q=${encodeURIComponent(
        url
      )}`;
      const response = await fetch(apiEndpoint, {
        headers: {
          "X-Linkpreview-Api-Key": this.settings.linkPreviewApiKey,
        },
      });
      const data = await response.json();
      return data.title;
    } catch (error) {
      console.error(error);
      return "";
    }
  }

  async fetchUrlTitle(url: string): Promise<string> {
    try {
      // New: Use gh CLI for GitHub pull request URLs.
      if (url.includes("github.com") && /\/pull\/\d+/.test(url)) {
        console.log("Fetching GitHub PR title via gh CLI");
        const prTitle = await getGithubPRTitle(url);
        if (prTitle) return prTitle;
      }

      let title = "";
      title = await this.fetchUrlTitleViaLinkPreview(url);
      console.log(`Title via Link Preview: ${title}`);

      if (title === "") {
        console.log("Title via Link Preview failed, falling back to scraper");
        if (this.settings.useNewScraper) {
          console.log("Using new scraper");
          title = await getPageTitle(url);
        } else {
          console.log("Using old scraper");
          title = await getElectronPageTitle(url);
        }
      }

      console.log(`Title: ${title}`);
      title =
        title.replace(/(\r\n|\n|\r)/gm, "").trim() ||
        "Title Unavailable | Site Unreachable";
      return title;
    } catch (error) {
      console.error(error);
      return "Error fetching title";
    }
  }

  public getUrlFromLink(link: string): string {
    let urlRegex = new RegExp(DEFAULT_SETTINGS.linkRegex);
    return urlRegex.exec(link)[2];
  }

  private getPasteId(): string {
    var base = "Fetching Title";
    if (this.settings.useBetterPasteId) {
      return this.getBetterPasteId(base);
    } else {
      return `${base}#${this.createBlockHash()}`;
    }
  }

  private getBetterPasteId(base: string): string {
    // After every character, add 0, 1 or 2 invisible characters
    // so that to the user it looks just like the base string.
    // The number of combinations is 3^14 = 4782969
    let result = "";
    var invisibleCharacter = "\u200B";
    var maxInvisibleCharacters = 2;
    for (var i = 0; i < base.length; i++) {
      var count = Math.floor(
        Math.random() * (maxInvisibleCharacters + 1)
      );
      result += base.charAt(i) + invisibleCharacter.repeat(count);
    }
    return result;
  }

  // Custom hashid by @shabegom
  private createBlockHash(): string {
    let result = "";
    var characters = "abcdefghijklmnopqrstuvwxyz0123456789";
    var charactersLength = characters.length;
    for (var i = 0; i < 4; i++) {
      result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
  }

  onunload() {
    console.log("unloading obsidian-auto-link-title");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
