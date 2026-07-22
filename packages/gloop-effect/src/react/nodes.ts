/**
 * gloop-effect/react/nodes — the "VDOM" an agent component returns.
 *
 * A component returns a tree of nodes describing what the agent *is* this turn.
 * `buildAgent` flattens the tree into a config draft and reconciles it — the
 * exact analogue of React elements flattening into DOM mutations.
 *
 * Falsy children (`null` / `false` / `undefined`) drop out, so conditional
 * config is just `cond && node`. A `tool()` builder is a valid child on its
 * own — you don't wrap it.
 */

import type { Skill } from "@hypen-space/gloop-loop"
import type { AnyTool } from "../Tool.js"
import type { Draft } from "./internal.js"
import type { ToolBuilder } from "./tool.js"

// ----------------------------------------------------------------------------
// Node ADT
// ----------------------------------------------------------------------------

export interface ModelNode {
  readonly _tag: "model"
  readonly id: string
}
export interface SystemNode {
  readonly _tag: "system"
  readonly text: string
}
export interface MaxTokensNode {
  readonly _tag: "maxTokens"
  readonly n: number
}
export interface SkillNode {
  readonly _tag: "skill"
  readonly skill: Skill
}
export interface DirectiveNode {
  readonly _tag: "directive"
  readonly text: string
  readonly as: "user" | "assistant"
}
export interface GroupNode {
  readonly _tag: "group"
  readonly children: Children
}

export type Node =
  | ModelNode
  | SystemNode
  | MaxTokensNode
  | SkillNode
  | DirectiveNode
  | GroupNode

/** Anything valid as a child: a node, a bare tool, a nested array, or falsy. */
export type Child =
  | Node
  | ToolBuilder
  | AnyTool
  | Children
  | false
  | null
  | undefined

export interface Children extends ReadonlyArray<Child> {}

/** A component returns a child tree — or nothing (a purely effectful agent). */
export type Rendered = Child | void

// ----------------------------------------------------------------------------
// Constructors
// ----------------------------------------------------------------------------

export const model = (id: string): ModelNode => ({ _tag: "model", id })
export const system = (text: string): SystemNode => ({ _tag: "system", text })
export const maxTokens = (n: number): MaxTokensNode => ({ _tag: "maxTokens", n })
export const skill = (s: Skill): SkillNode => ({ _tag: "skill", skill: s })

/**
 * An ephemeral, per-turn instruction delivered as a hidden message — NOT the
 * standing system prompt. Injected just before the responder generates and
 * stripped from history afterward, so it steers only this one answer.
 * `as: "assistant"` prefills the responder's own voice; `"user"` (default)
 * reads as an out-of-band directive.
 */
export const directive = (
  text: string,
  as: "user" | "assistant" = "user",
): DirectiveNode => ({ _tag: "directive", text, as })

/** Group children into one node — the fragment / `<>…</>` of this world. */
export const group = (...children: Children): GroupNode => ({
  _tag: "group",
  children,
})

// ----------------------------------------------------------------------------
// Flatten a rendered tree into the config draft
// ----------------------------------------------------------------------------

const isTool = (x: object): x is AnyTool =>
  "name" in x && "execute" in x && "arguments" in x

/** Walk the tree depth-first, writing config into `draft`. */
export const flatten = (child: Rendered, draft: Draft): void => {
  if (child === null || child === undefined || child === false) return

  if (Array.isArray(child)) {
    for (const c of child) flatten(c as Rendered, draft)
    return
  }

  const node = child as Node | AnyTool | ToolBuilder

  if ("_tag" in node) {
    switch (node._tag) {
      case "model":
        draft.model = node.id
        return
      case "system":
        draft.systemParts.push(node.text)
        return
      case "maxTokens":
        draft.maxTokens = node.n
        return
      case "skill":
        draft.skills.push(node.skill)
        return
      case "directive":
        draft.directives.push({ text: node.text, as: node.as })
        return
      case "group":
        flatten(node.children as Rendered, draft)
        return
    }
  }

  if (isTool(node)) {
    draft.tools.push(node)
    return
  }
}
