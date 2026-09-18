import type {
  ConstraintCandidate,
  FileCandidate,
  MessageCategory,
  NormalizedTranscript,
  ToolDecisionKind,
} from "../domain/types.js"
import type { JevState } from "../state/build.js"
import type { ChoiceQuestion, JevQuestion, NoulQuestion, ScoreQuestion } from "./types.js"

export interface ToolQuestionIds {
  keepCall: string
  exactEvidence: string
  unresolvedBlocker: string
  completedWork: string
  repeatWorkRisk: string
  superseded: string
  truncateSafe: string
  safeToDiscard: string
  action: string
  relevance: string
}

export interface TextQuestionIds {
  keep: string
  safeToDiscard: string
  superseded: string
  relevance: string
  category: string
}

export interface QuestionPlan {
  questions: Record<string, JevQuestion>
  tools: Map<string, ToolQuestionIds>
  texts: Map<string, TextQuestionIds>
  constraints: Map<string, string>
  files: Map<string, string>
}

const CATEGORIES: Record<MessageCategory, string> = {
  objective: "This text states the current objective or requested outcome.",
  constraint: "This text states a requirement, guardrail, preference, or must-preserve condition.",
  decision: "This text records a durable decision or chosen approach.",
  completed: "This text records completed work whose fact still matters and should not be repeated.",
  active: "This text records unfinished active work or current implementation state.",
  next_move: "This text states the concrete next action.",
  evidence: "This text is exact evidence that may be needed later, such as an error, value, command, path, or identifier.",
  irrelevant: "This text is stale, superseded, conversational, or unnecessary for continuing the objective.",
}

const TOOL_CHOICES: Record<ToolDecisionKind, string> = {
  keep_full: "Keep the tool call and complete result because exact result content remains useful.",
  keep_call_truncate_result: "Keep the tool call and a short exact prefix of the result; the complete result is unnecessary.",
  drop: "Drop the tool call and result because losing both will not harm continuation quality.",
}

const RELEVANCE_LEVELS = [
  "0: unrelated or fully obsolete for the current next move",
  "1: weak background value only",
  "2: somewhat relevant but not required",
  "3: materially relevant to the current next move",
  "4: directly required to make the current next move correctly",
]

function noul(instructions: string, yes: string, no: string): NoulQuestion {
  return { type: "noul", instructions, criteria: { true: yes, false: no } }
}

function score(instructions: string): ScoreQuestion {
  return { type: "score", instructions, criteria: RELEVANCE_LEVELS }
}

function choice(instructions: string, criteria: Record<string, string>): ChoiceQuestion {
  return { type: "choice", instructions, criteria }
}

export function buildQuestionPlan(
  state: JevState,
  transcript: NormalizedTranscript,
  constraints: ConstraintCandidate[],
  files: FileCandidate[],
): QuestionPlan {
  const questions: Record<string, JevQuestion> = {}
  const tools = new Map<string, ToolQuestionIds>()
  const texts = new Map<string, TextQuestionIds>()
  const constraintIds = new Map<string, string>()
  const fileIds = new Map<string, string>()

  for (let index = 0; index < state.tools.length; index += 1) {
    const tool = state.tools[index]
    if (!tool || tool.pinned) continue
    const prefix = `tool_${index}`
    const ids: ToolQuestionIds = {
      keepCall: `${prefix}_keep_call`,
      exactEvidence: `${prefix}_exact_evidence`,
      unresolvedBlocker: `${prefix}_unresolved_blocker`,
      completedWork: `${prefix}_completed_work`,
      repeatWorkRisk: `${prefix}_repeat_work_risk`,
      superseded: `${prefix}_superseded`,
      truncateSafe: `${prefix}_truncate_safe`,
      safeToDiscard: `${prefix}_safe_to_discard`,
      action: `${prefix}_action`,
      relevance: `${prefix}_relevance`,
    }

    questions[ids.keepCall] = noul(
      `Is \`tools[${index}].call\` still useful to continue the current objective or preserve provenance for active/completed work?`,
      "The call identifies an action, command, query, input, or provenance still useful to continue correctly or avoid rediscovery.",
      "The call has no remaining value for continuation, provenance, or avoiding repeated work.",
    )
    questions[ids.exactEvidence] = noul(
      `Does \`tools[${index}].result\` contain exact values, errors, paths, commands, identifiers, or output whose precise wording/content may still be needed?`,
      "Exact result content still matters; rewriting or excessive truncation could lose useful evidence.",
      "No exact result detail is still needed.",
    )
    questions[ids.unresolvedBlocker] = noul(
      `Does \`tools[${index}]\` contain an unresolved failure, error, blocker, or diagnostic that still affects active work?`,
      "The item contains an unresolved condition that future work must still account for.",
      "The item contains no unresolved blocker relevant to active work.",
    )
    questions[ids.completedWork] = noul(
      `Does \`tools[${index}]\` establish completed work, a successful action, or a fact that should be remembered so it is not repeated?`,
      "The item records completed work or a result whose completion state should survive.",
      "The item does not establish durable completed work that needs to survive.",
    )
    questions[ids.repeatWorkRisk] = noul(
      `Would discarding \`tools[${index}]\` likely cause the agent to repeat investigation, execution, retrieval, or validation work?`,
      "Losing the item creates a meaningful risk of redoing work or re-fetching evidence.",
      "Discarding the item should not cause meaningful repeated work.",
    )
    questions[ids.superseded] = noul(
      `Has \`tools[${index}]\` been superseded by newer information or a later successful action in state?`,
      "A later item replaces the useful information or action from this item.",
      "This item is not superseded, or the state does not establish supersession.",
    )
    questions[ids.truncateSafe] = noul(
      `If \`tools[${index}].call\` is kept, would keeping only a short exact prefix of \`tools[${index}].result\` preserve all remaining practical value?`,
      "A short exact prefix plus the call preserves what still matters.",
      "Important useful content could exist beyond a short prefix, so full retention is safer.",
    )
    questions[ids.safeToDiscard] = noul(
      `Can the entire \`tools[${index}]\` item be discarded without losing useful evidence, hiding an unresolved blocker, forgetting completed work, causing repeated work, or impairing the current objective?`,
      "The whole item is safely disposable for future continuation.",
      "There is any meaningful reason the item should survive in full or truncated form.",
    )
    questions[ids.action] = choice(
      `Choose the retention treatment for \`tools[${index}]\`. Do not summarize or rewrite it.`,
      TOOL_CHOICES,
    )
    questions[ids.relevance] = score(`Score how relevant \`tools[${index}].result\` is to the current next move.`)
    tools.set(tool.id, ids)
  }

  const stateTextIndex = new Map(state.textBlocks.map((block, index) => [block.id, index] as const))
  for (const block of transcript.textBlocks) {
    if (!block.checkpointEligible || block.pinned || block.source === "unknown-part") continue
    const index = stateTextIndex.get(block.id)
    if (index === undefined) continue
    const prefix = `text_${texts.size}`
    const ids: TextQuestionIds = {
      keep: `${prefix}_keep`,
      safeToDiscard: `${prefix}_safe_to_discard`,
      superseded: `${prefix}_superseded`,
      relevance: `${prefix}_relevance`,
      category: `${prefix}_category`,
    }
    questions[ids.keep] = noul(
      `Should \`textBlocks[${index}].text\` survive the checkpoint verbatim because it contains useful objective, constraint, decision, completion state, active state, next step, or exact evidence?`,
      "The exact text still contains useful durable context.",
      "The exact text has no durable value for continuing the session.",
    )
    questions[ids.safeToDiscard] = noul(
      `Can \`textBlocks[${index}].text\` be discarded without losing durable context or causing the agent to repeat or misunderstand work?`,
      "The text is safely disposable.",
      "The text should survive because it still carries useful session state.",
    )
    questions[ids.superseded] = noul(
      `Has the information in \`textBlocks[${index}].text\` been superseded by newer retained information in state?`,
      "Newer state makes this text obsolete.",
      "The text is not clearly superseded.",
    )
    questions[ids.relevance] = score(`Score the relevance of \`textBlocks[${index}].text\` to the current next move.`)
    questions[ids.category] = choice(
      `Classify the primary checkpoint role of \`textBlocks[${index}].text\`.`,
      CATEGORIES,
    )
    texts.set(block.id, ids)
  }

  for (let index = 0; index < constraints.length; index += 1) {
    const candidate = constraints[index]
    if (!candidate) continue
    const id = `constraint_${index}_keep`
    questions[id] = noul(
      `Must \`constraints[${index}]\` remain in the checkpoint to satisfy the current objective correctly?`,
      "The constraint still applies and losing it could cause incorrect future work.",
      "The constraint is obsolete, superseded, or no longer applicable.",
    )
    constraintIds.set(candidate.id, id)
  }

  for (let index = 0; index < files.length; index += 1) {
    const candidate = files[index]
    if (!candidate) continue
    const id = `file_${index}_active`
    questions[id] = noul(
      `Is \`files[${index}].path\` still in play for the current objective?`,
      "The file or path is still being edited, read, validated, or needed as exact context.",
      "The file or path is no longer relevant to active work.",
    )
    fileIds.set(candidate.id, id)
  }


  return {
    questions,
    tools,
    texts,
    constraints: constraintIds,
    files: fileIds,
  }
}
