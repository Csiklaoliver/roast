require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3002;

// Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Middleware
app.use(express.json());
app.use(cors({
  origin: ['http://roast.oliverprojects.tech', 'https://roast.oliverprojects.tech', 'http://localhost:3002'],
  credentials: true,
}));

// Rate limiter: 10 requests per IP per hour
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Slow down. Even bad code needs a break.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Parse GitHub URL
function parseGitHubUrl(url) {
  try {
    const cleaned = url.trim().replace(/\/$/, '').replace(/\.git$/, '');
    const match = cleaned.match(/github\.com[/:]([^/]+)\/([^/]+)/);
    if (!match) return null;
    return { owner: match[1], repo: match[2] };
  } catch {
    return null;
  }
}

// GitHub API helper
async function githubFetch(url) {
  const headers = { 'User-Agent': 'RoastMyRepo/1.0', 'Accept': 'application/vnd.github.v3+json' };
  if (process.env.GITHUB_TOKEN) headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (res.status === 404) throw new Error('REPO_NOT_FOUND');
  if (res.status === 403) throw new Error('RATE_LIMITED');
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  return res.json();
}

// Fetch all GitHub data for a repo
async function fetchRepoData(owner, repo) {
  const base = `https://api.github.com/repos/${owner}/${repo}`;

  const [repoInfo, languages, commits, contents] = await Promise.allSettled([
    githubFetch(base),
    githubFetch(`${base}/languages`),
    githubFetch(`${base}/commits?per_page=5`),
    githubFetch(`${base}/contents`),
  ]);

  if (repoInfo.status === 'rejected') {
    const err = repoInfo.reason.message;
    if (err === 'REPO_NOT_FOUND') throw new Error('REPO_NOT_FOUND');
    if (err === 'RATE_LIMITED') throw new Error('RATE_LIMITED');
    throw repoInfo.reason;
  }

  // Try to get README
  let readme = null;
  try {
    const readmeData = await githubFetch(`${base}/readme`);
    if (readmeData.content) {
      readme = Buffer.from(readmeData.content, 'base64').toString('utf-8').slice(0, 2000);
    }
  } catch {
    readme = null;
  }

  const info = repoInfo.value;
  const langs = languages.status === 'fulfilled' ? languages.value : {};
  const commitList = commits.status === 'fulfilled' ? commits.value : [];
  const fileTree = contents.status === 'fulfilled' ? contents.value : [];

  // Format commit messages
  const recentCommits = commitList.slice(0, 5).map(c => ({
    message: c.commit?.message?.split('\n')[0] || 'unknown',
    date: c.commit?.author?.date || 'unknown',
    author: c.commit?.author?.name || 'unknown',
  }));

  // Format file tree
  const files = Array.isArray(fileTree)
    ? fileTree.map(f => `${f.type === 'dir' ? '📁' : '📄'} ${f.name}`).join('\n')
    : 'Could not fetch file tree';

  // Calculate days since last commit
  const lastCommitDate = recentCommits[0]?.date;
  let daysSinceCommit = null;
  if (lastCommitDate) {
    daysSinceCommit = Math.floor((Date.now() - new Date(lastCommitDate)) / (1000 * 60 * 60 * 24));
  }

  return {
    name: info.name,
    fullName: info.full_name,
    description: info.description || 'No description. Classic.',
    primaryLanguage: info.language || 'None',
    stars: info.stargazers_count || 0,
    forks: info.forks_count || 0,
    openIssues: info.open_issues_count || 0,
    size: info.size || 0,
    createdAt: info.created_at,
    updatedAt: info.updated_at,
    isPrivate: info.private,
    hasWiki: info.has_wiki,
    hasPages: info.has_pages,
    defaultBranch: info.default_branch,
    languages: langs,
    recentCommits,
    daysSinceCommit,
    readme,
    files,
    topics: info.topics || [],
    license: info.license?.name || 'No license',
    archived: info.archived || false,
  };
}

// Build Claude prompt
function buildPrompt(data) {
  const langList = Object.keys(data.languages).join(', ') || data.primaryLanguage || 'Unknown';
  const commitMessages = data.recentCommits.map(c => `"${c.message}" by ${c.author}`).join('\n');

  return `You are roasting this GitHub repository. Here is the data:

REPO: ${data.fullName}
DESCRIPTION: ${data.description}
LANGUAGE(S): ${langList}
PRIMARY LANGUAGE: ${data.primaryLanguage}
STARS: ${data.stars}
FORKS: ${data.forks}
OPEN ISSUES: ${data.openIssues}
REPO SIZE: ${data.size}KB
CREATED: ${data.createdAt}
LAST UPDATED: ${data.updatedAt}
DAYS SINCE LAST COMMIT: ${data.daysSinceCommit ?? 'unknown'}
LICENSE: ${data.license}
ARCHIVED: ${data.archived}
TOPICS: ${data.topics.join(', ') || 'none'}
DEFAULT BRANCH: ${data.defaultBranch}

RECENT COMMITS (last 5):
${commitMessages || 'No commits found'}

FILE TREE (root level):
${data.files}

README (first 2000 chars):
${data.readme || 'No README found. Brave.'}

Now roast this repository. Be brutal, specific, and hilarious. Focus on what you can actually see in the data above.`;
}

// POST /api/roast
app.post('/api/roast', limiter, async (req, res) => {
  const { repoUrl } = req.body;

  if (!repoUrl) {
    return res.status(400).json({ error: "That's not a GitHub URL. Like your code, invalid." });
  }

  const parsed = parseGitHubUrl(repoUrl);
  if (!parsed) {
    return res.status(400).json({ error: "That's not a GitHub URL. Like your code, invalid." });
  }

  try {
    // Fetch GitHub data
    const repoData = await fetchRepoData(parsed.owner, parsed.repo);

    if (repoData.isPrivate) {
      return res.status(403).json({ error: 'This repo is too ashamed to be public.' });
    }

    // Call Claude
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system: `You are a brutally honest, savage but funny code reviewer.
Your job is to roast GitHub repositories like a comedy roast — brutal, specific, and hilarious, but never genuinely mean-spirited.
Focus on: variable names, commit messages, README quality, file structure, language choices, last commit date, open issues, code-to-readme ratio, and any other red flags.
Respond ONLY in raw JSON (no markdown, no backticks):
{
  "score": 4.2,
  "scoreLabel": "CRIES IN JAVASCRIPT",
  "roastLines": [
    "Your last commit was 3 years ago. The code did not age well either.",
    "47 open issues and a README that just says TODO. Bold strategy.",
    "You named a variable temp2. temp1 was not good enough?",
    "The entire project is one 2000-line index.js. Brave."
  ],
  "redeemingQuality": "At least you pushed to GitHub. Most peoples bad code never leaves their laptop.",
  "worstOffense": "Your last commit message was fix"
}
Score guide:
1-3: catastrophic
4-5: concerning
6-7: mediocre but survivable
8-9: actually decent (be reluctantly impressed)
10: perfect (be suspicious and paranoid about it)`,
      messages: [
        { role: 'user', content: buildPrompt(repoData) }
      ],
    });

    // Parse Claude's response
    let roastData;
    try {
      const rawText = message.content[0].text.trim();
      // Strip any accidental markdown code fences
      const jsonText = rawText.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();
      roastData = JSON.parse(jsonText);
    } catch {
      return res.status(500).json({ error: "Our roaster broke. Probably JavaScript's fault." });
    }

    // Return roast + repo stats
    return res.json({
      roast: roastData,
      repo: {
        name: repoData.name,
        fullName: repoData.fullName,
        description: repoData.description,
        stars: repoData.stars,
        forks: repoData.forks,
        openIssues: repoData.openIssues,
        primaryLanguage: repoData.primaryLanguage,
        languages: repoData.languages,
        daysSinceCommit: repoData.daysSinceCommit,
        lastCommit: repoData.recentCommits[0]?.date || null,
        license: repoData.license,
        topics: repoData.topics,
      }
    });

  } catch (err) {
    if (err.message === 'REPO_NOT_FOUND') {
      return res.status(404).json({ error: "Repo not found. Maybe it's as invisible as your commit history." });
    }
    if (err.message === 'RATE_LIMITED') {
      return res.status(429).json({ error: 'GitHub rate limited us. Slow down. Even bad code needs a break.' });
    }
    console.error('Roast error:', err);
    return res.status(500).json({ error: "Our roaster broke. Probably JavaScript's fault." });
  }
});

// Catch-all: serve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🔥 Roast My Repo running on port ${PORT}`);
});
