// Mode detection and access control.
//   tag        — someone mentioned the trigger phrase / applied the label / assigned the bot.
//   automation — the workflow supplied a prompt.
//   skip       — neither: the action exits quietly.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function containsTrigger(text, phrase) {
  if (!text || !phrase) return false;
  return new RegExp(`(^|[^\\w-])${escapeRe(phrase)}(?![\\w-])`, 'i').test(text);
}

export function globToRegex(glob) {
  return new RegExp(`^${glob.split('*').map(escapeRe).join('.*')}$`, 'i');
}

export function matchesAny(value, globs) {
  return globs.some((g) => globToRegex(g).test(value));
}

/** Returns { mode, reason, triggerText } */
export function detectMode(ctx, inputs) {
  const p = ctx.payload;
  const phrase = inputs.triggerPhrase;
  let triggerText = null;
  let reason = '';

  switch (ctx.eventName) {
    case 'issue_comment':
    case 'pull_request_review_comment':
      if (['created', 'edited'].includes(ctx.action) && containsTrigger(p.comment?.body, phrase)) {
        triggerText = p.comment.body;
        reason = `comment mentions ${phrase}`;
      }
      break;
    case 'pull_request_review':
      if (ctx.action === 'submitted' && containsTrigger(p.review?.body, phrase)) {
        triggerText = p.review.body;
        reason = `review mentions ${phrase}`;
      }
      break;
    case 'issues':
      if (ctx.action === 'assigned' && inputs.assigneeTrigger && p.assignee?.login?.toLowerCase() === inputs.assigneeTrigger.toLowerCase()) {
        triggerText = `${p.issue.title}\n\n${p.issue.body ?? ''}`;
        reason = `issue assigned to ${inputs.assigneeTrigger}`;
      } else if (ctx.action === 'labeled' && inputs.labelTrigger && p.label?.name?.toLowerCase() === inputs.labelTrigger.toLowerCase()) {
        triggerText = `${p.issue.title}\n\n${p.issue.body ?? ''}`;
        reason = `label "${inputs.labelTrigger}" applied`;
      } else if (!inputs.prompt && ['opened', 'edited'].includes(ctx.action) && (containsTrigger(p.issue?.body, phrase) || containsTrigger(p.issue?.title, phrase))) {
        // (with a prompt, an issue / PR event is an automation: the body is context, not a request)
        triggerText = `${p.issue.title}\n\n${p.issue.body ?? ''}`;
        reason = `issue mentions ${phrase}`;
      }
      break;
    case 'pull_request':
    case 'pull_request_target':
      if (!inputs.prompt && ['opened', 'edited'].includes(ctx.action) && containsTrigger(p.pull_request?.body, phrase)) {
        triggerText = `${p.pull_request.title}\n\n${p.pull_request.body ?? ''}`;
        reason = `pull request mentions ${phrase}`;
      }
      break;
    default:
      break;
  }

  if (triggerText !== null) return { mode: 'tag', reason, triggerText };
  if (inputs.prompt) return { mode: 'automation', reason: 'prompt input supplied', triggerText: null };
  return { mode: 'skip', reason: `no prompt and no ${phrase} trigger in this ${ctx.eventName || 'event'}`, triggerText: null };
}

// Verbs that ask for a change, at the start of the request (after "please", "can you"…).
const DO_VERBS = [
  'fix', 'implement', 'add', 'create', 'change', 'update', 'refactor', 'remove', 'delete', 'rename', 'write', 'make', 'apply',
  'commit', 'push', 'open', 'migrate', 'bump', 'upgrade', 'replace', 'move', 'convert', 'rewrite', 'improve', 'optimize',
  'optimise', 'clean', 'format', 'resolve', 'patch', 'build', 'generate', 'set', 'enable', 'disable', 'revert', 'translate', 'document',
  'run', 'install', 'lance', 'lancer', 'exécute', 'executer', 'exécuter', 'installe',
  'corrige', 'corriger', 'implémente', 'implementer', 'implémenter', 'ajoute', 'ajouter', 'crée', 'créer', 'cree', 'modifie', 'modifier',
  'change', 'changer', 'supprime', 'supprimer', 'renomme', 'renommer', 'écris', 'écrire', 'fais', 'faire', 'applique', 'appliquer',
  'mets', 'mettre', 'remplace', 'remplacer', 'déplace', 'deplace', 'refactorise', 'refactoriser', 'améliore', 'ameliore', 'nettoie',
  'génère', 'genere', 'traduis', 'documente', 'migre', 'répare', 'repare',
];
// Words that open a question or an analysis request. They win over DO_VERBS.
const ASK_LEADS = [
  'why', 'what', 'how', 'which', 'where', 'when', 'who', 'whether', 'is', 'are', 'does', 'should',
  'explain', 'review', 'compare', 'assess', 'audit', 'summarize', 'summarise', 'describe', 'analyze', 'analyse',
  'pourquoi', 'quoi', 'comment', 'quel', 'quelle', 'quels', 'quelles', 'qu', 'est-ce', 'est', 'explique', 'expliquer',
  'résume', 'resume', 'audite', 'décris', 'decris',
];
const LEAD = /^(?:(?:hey|hi|ok|okay|please|pls|stp|svp|merci de|peux[- ]tu|tu peux|pourrais[- ]tu|can you|could you|would you|go ahead and|now|maintenant|alors|and|et|also|aussi)[\s,:!-]+)*/i;
// A scoping preamble such as "in src/a.mjs, " or "on line 12: " that hides the real verb.
const SCOPE = /^(?:in|on|at|for|dans|sur|pour|en)\s+[^,:\n]{1,80}[,:]\s*/i;
// `ask` / `do` as an explicit switch; "do you think", "do not change" and "does" are ordinary sentences.
const FORCED = /^(ask|do)(?![\p{L}\p{N}_'’-])(?!\s+(?:you|we|i|they|not|n't)\b)[\s:,-]*/iu;

/**
 * Tag mode: is this a question (answer it, read-only, with recommendations) or a request to
 * change code? `ask` / `do` right after the trigger phrase force it.
 *
 * Heuristic, in order:
 *  1. Keep only the text after the FIRST occurrence of `phrase` (case-insensitive). Anything
 *     before it is ignored; if `phrase` is absent, the whole text is used.
 *  2. A leading `ask` / `do` forces the result (`@harness do: the fix`, `@harness ask fix or rewrite?`).
 *     Ordinary sentences such as "do you think…", "do not change…" or "does this…" do not count.
 *  3. Strip politeness / filler (`LEAD`: "please", "can you", "peux-tu"…), then a scoping preamble
 *     (`SCOPE`: "in src/a.mjs, ", "on line 12: "), then filler again, so the real verb is exposed.
 *  4. Take the first word (letters and hyphens only, so "qu'est-ce" yields "qu"). A word in
 *     `ASK_LEADS` (question / analysis words) gives `'ask'`; a word in `DO_VERBS` gives `'do'`.
 *  5. Anything else, including an empty request, gives `'ask'`. This is deliberate: when the
 *     intent is unclear, answering read-only is safer than editing code.
 *
 * Only the first word is looked at, in English and French. To support another verb or language,
 * extend `DO_VERBS` / `ASK_LEADS`; `test/unit/core.test.mjs` ("tag mode intent") lists the expected cases.
 *
 * In `prepare` this is only called for `tag` mode, and not at all when the `ask_mode` input is
 * `off` (always `'do'`) or `always` (always `'ask'`). `'ask'` makes the run read-only with a single
 * iteration. For `issues` and `pull_request` events, `text` is the title followed by the body.
 *
 * @param {string} text The text that triggered the run (comment body, or title + body).
 * @param {string} phrase The trigger phrase, e.g. `@harness`.
 * @returns {'ask'|'do'}
 */
export function classifyIntent(text, phrase) {
  const idx = text.toLowerCase().indexOf(phrase.toLowerCase());
  let req = (idx >= 0 ? text.slice(idx + phrase.length) : text).trim();
  const forced = FORCED.exec(req);
  if (forced) return forced[1].toLowerCase();
  req = req.replace(LEAD, '').replace(SCOPE, '').replace(LEAD, '');
  const first = (/^[\p{L}-]+/u.exec(req)?.[0] ?? '').toLowerCase();
  if (ASK_LEADS.includes(first)) return 'ask';
  return DO_VERBS.includes(first) ? 'do' : 'ask';
}

/** Does this run publish into a tracking comment on an issue / PR? */
export function wantsTrackingComment(ctx, inputs, mode) {
  if (!ctx.number) return false;
  if (mode === 'tag') return true;
  return inputs.trackProgress && ['pull_request', 'pull_request_target', 'issues', 'issue_comment'].includes(ctx.eventName);
}

const COMMENT_EVENTS = new Set(['issue_comment', 'pull_request_review_comment', 'pull_request_review', 'issues', 'discussion_comment']);

/**
 * Who may wake the agent up. Anyone can comment on a public repository, so a human actor must
 * have write access unless explicitly allowed; bots must be explicitly allowed.
 */
export async function checkAccess(ctx, inputs, mode, github) {
  const needsCheck = mode === 'tag' || COMMENT_EVENTS.has(ctx.eventName);
  if (!needsCheck) return { allowed: true, reason: `${ctx.eventName} is not a user-triggered event` };
  const actor = ctx.actor;
  const isBot = ctx.senderType === 'Bot' || /\[bot\]$/i.test(actor);
  if (isBot) {
    const bare = actor.replace(/\[bot\]$/i, '');
    const ok = inputs.allowedBots.includes('*') || inputs.allowedBots.some((b) => b.replace(/\[bot\]$/i, '').toLowerCase() === bare.toLowerCase());
    return ok ? { allowed: true, reason: `bot ${actor} is allowed` } : { allowed: false, reason: `bot ${actor} is not in allowed_bots` };
  }
  if (inputs.allowedNonWriteUsers.includes('*') || inputs.allowedNonWriteUsers.some((u) => u.toLowerCase() === actor.toLowerCase())) {
    return { allowed: true, reason: `${actor} is in allowed_non_write_users` };
  }
  try {
    const res = await github.get(`/repos/${ctx.owner}/${ctx.repo}/collaborators/${encodeURIComponent(actor)}/permission`);
    const perm = res?.permission ?? 'none';
    const role = res?.role_name ?? perm;
    if (['admin', 'write', 'maintain'].includes(perm) || ['admin', 'maintain', 'write'].includes(role)) {
      return { allowed: true, reason: `${actor} has ${role} access` };
    }
    return { allowed: false, reason: `${actor} has ${role} access; write access is required` };
  } catch (err) {
    if (err.status === 404) return { allowed: false, reason: `${actor} is not a collaborator` };
    throw err;
  }
}

/** include / exclude comment authors (exclusion wins). */
export function keepCommentAuthor(login, inputs) {
  if (inputs.excludeCommentsByActor.length && matchesAny(login, inputs.excludeCommentsByActor)) return false;
  if (inputs.includeCommentsByActor.length) return matchesAny(login, inputs.includeCommentsByActor);
  return true;
}
