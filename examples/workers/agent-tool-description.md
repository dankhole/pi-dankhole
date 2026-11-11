Launch an autonomous worker for a complex, multi-step task. Its description is the short visible goal; its returned ID identifies its conversation.

Use direct tools when the target is already known. Delegate independent implementation, exploration or context-heavy research when parallel progress or a separate context outweighs coordination cost.

## Usage notes
- Supply a short (3-5 word) description and a self-contained prompt. State the objective, relevant evidence, decisions, file ownership, authorization boundaries, acceptance criteria and completed checks.
- Workers inherit the parent's system rules. instructions adds to those rules rather than replacing them. inherit_context separately includes the parent's conversation history.
- Configure tools, disallowed_tools, extensions, exclude_extensions, skills, instructions, model, thinking, session persistence, transcript output and memory directly at launch. Omitted model and thinking inherit the parent. These scopes are not an operating-system sandbox.
- For independent parallel tasks, make multiple Agent calls in one message. Do not duplicate work already delegated.
- Workers run in the background by default and notify you when they complete. Do not poll or sleep waiting for them; continue useful independent work. Use run_in_background: false only when the next action depends on the result and nothing else can progress.
- Never fabricate or predict a pending worker's results. Its summary describes intent, not verified outcome: inspect actual changes before reporting success. The result is not shown to the user; summarize it when appropriate.
- Use get_subagent_result and steer_subagent with the returned worker ID. stop_subagent requests cancellation of running or queued work without waiting for settlement. Descriptions are labels, not handles.
- resume continues the original conversation and launch configuration. It accepts prompt, optional description, run_in_background and max_turns only; start a new worker to change tools, rules or model. A running worker must be steered, not resumed.
- Only the main agent launches and controls workers. Workers report further work or coordination needs to the main agent; they cannot delegate further.{{isolationGuideline}}

## Writing the prompt

Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.
