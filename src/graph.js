const {nullMatch, anyMatch, StringMatch, RangeMatch, SeqMatch, ChoiceMatch, RepeatMatch,
       LookaheadMatch, SimpleLookaheadMatch, eqArray} = require("./matchexpr")

class Graph {
  constructor(grammar) {
    this.nodes = Object.create(null)
    this.curRule = null
    this.rules = Object.create(null)
    let first = null
    for (let name in grammar.rules) {
      if (first == null) first = name
      let ast = grammar.rules[name]
      this.rules[name] = {name,
                          context: ast.context,
                          tokenType: ast.tokenType,
                          space: ast.space && ast.space.name,
                          expr: ast.expr,
                          start: null}
    }

    if (!first) throw new SyntaxError("Empty grammar")
    if (this.rules._TOKEN) throw new SyntaxError("The rule name '_TOKEN' is reserved")
    let tokens = []
    for (let name in this.rules)
      if (grammar.rules[name].isToken) tokens.push(name)

    if (this.rules.START) this.getRule("START")
    else this.buildStartRule(first)
    this.buildTokenRule(tokens)
  }

  getRule(name) {
    let rule = this.rules[name]
    if (!rule.start) {
      this.withRule(rule, () => {
        let start = rule.start = this.node()
        let end = this.node(null, "end")
        if (rule.context || rule.tokenType) {
          let push = this.node(null, "push")
          this.edge(start, push, null, [new PushContext(name, rule.context, rule.tokenType)])
          start = push
        }
        generateExpr(start, end, rule.expr, this)
        this.edge(end, null, null, rule.context || rule.tokenType? [popContext, returnEffect] : [returnEffect])
      })
    }
    return rule
  }

  node(base, suffix) {
    let label = (base || this.curRule.name) + (suffix ? "_" + suffix : "")
    for (let i = 0;; i++) {
      let cur = i ? label + "_" + i : label
      if (!(cur in this.nodes)) {
        this.nodes[cur] = []
        return cur
      }
    }
  }

  edge(from, to, match, effects) {
    let edge = new Edge(to, match || nullMatch, effects)
    this.nodes[from].push(edge)
    return edge
  }

  withRule(rule, f) {
    let prevRule = this.curRule
    this.curRule = rule
    f()
    this.curRule = prevRule
  }

  gc() {
    let reached = this.forEachRef()
    for (let n in this.nodes) if (!(n in reached)) delete this.nodes[n]
  }

  forEachRef(f) {
    let reached = Object.create(null), work = []

    function reach(from, to, type) {
      if (f) f(from, to, type)
      if (!to || (to in reached)) return
      reached[to] = true
      work.push(to)
    }
    reach(null, this.rules.START.start, "start")
    reach(null, this.rules._TOKEN.start, "start")

    while (work.length) {
      let node = work.pop(), next = this.nodes[node]
      for (let i = 0; i < next.length; i++) {
        let edge = next[i]
        if (edge.to) reach(node, edge.to, "edge")
        if (edge.match instanceof LookaheadMatch)
          reach(node, edge.match.start, "lookahead")
        for (let j = 0; j < edge.effects.length; j++)
          if (edge.effects[j] instanceof CallEffect)
            reach(node, edge.effects[j].returnTo, "return")
      }
    }
    return reached
  }

  buildStartRule(first) {
    let rule = this.rules.START = {
      name: "START",
      space: this.rules[first].space,
      start: this.node("START")
    }
    let cur = rule.start, space = rule.space && this.getRule(rule.space)
    if (space) {
      let next = this.node("START")
      this.edge(cur, space.start, null, [new CallEffect(rule.space, next)])
      cur = next
    }
    callRule(cur, rule.start, first, this)
  }

  buildTokenRule(tokens) {
    let rule = this.rules._TOKEN = {
      name: "_TOKEN",
      start: this.node("_TOKEN")
    }, end = this.node("_TOKEN", "end")
    this.edge(end, null, null, [returnEffect])
    for (let i = 0; i < tokens.length; i++)
      callRule(rule.start, end, tokens[i], this)
    this.edge(rule.start, end, anyMatch)
  }

  merge(a, b) {
    delete this.nodes[b]
    for (let node in this.nodes) {
      let edges = this.nodes[node]
      for (let i = 0; i < edges.length; i++) edges[i].merge(a, b)
    }
    for (let name in this.rules) {
      if (this.rules[name].start == b) this.rules[name].start = a
    }
  }

  toString() {
    let output = "digraph {\n"
    for (let node in this.nodes) {
      let edges = this.nodes[node]
      for (let i = 0; i < edges.length; i++)
        output += "  " + edges[i].toString(node) + ";\n"
    }
    return output + "}\n"
  }

  countIncoming(node) {
    let count = 0
    for (let n in this.nodes) {
      let edges = this.nodes[n]
      for (let i = 0; i < edges.length; i++) if (edges[i].to == node) count++
    }
    return count
  }
}

class Edge {
  constructor(to, match, effects) {
    this.to = to
    this.match = match
    this.effects = effects || []
  }

  eq(other) {
    return this.to == other.to && this.match.eq(other.match) && eqArray(this.effects, other.effects)
  }

  merge(a, b) {
    if (this.to == b) this.to = a
    for (let i = 0; i < this.effects.length; i++) this.effects[i].merge(a, b)
    if (this.match instanceof LookaheadMatch && this.match.start == b) this.match.start = a
  }

  toString(from) {
    let effects = this.effects.length ? " " + this.effects.join(" ") : ""
    return `${from} -> ${this.to || "NULL"}[label=${JSON.stringify(this.match.regexp() + effects)}]`
  }
}

function forAllExprs(e, f) {
  f(e)
  if (e.exprs) for (let i = 0; i < e.exprs.length; i++) forAllExprs(e.exprs[i], f)
  if (e.expr) {
    forAllExprs(e.expr, f)
    if (e.type == "+") forAllExprs(e.expr, f) // The body of + is duplicated
  }
}

const CallEffect = exports.CallEffect = class {
  constructor(rule, returnTo) {
    this.rule = rule
    this.returnTo = returnTo
  }

  eq(other) {
    return other instanceof CallEffect && other.rule == this.rule && other.returnTo == this.returnTo
  }

  merge(a, b) { if (this.returnTo == b) this.returnTo = a }

  toString() { return `call ${this.rule} -> ${this.returnTo}` }
}

const returnEffect = exports.returnEffect = new class ReturnEffect {
  eq(other) { return other == this }

  merge() {}

  toString() { return "return" }
}

const PushContext = exports.PushContext = class {
  constructor(name, context, tokenType) {
    this.name = name
    this.context = context
    this.tokenType = tokenType
  }
  eq(other) { return other instanceof PushContext && other.name == this.name }
  merge() {}
  toString() { return `push ${this.name}` }
}

const popContext = exports.popContext = new class PopContext {
  eq(other) { return other == this }
  merge() {}
  toString() { return "pop" }
}

function rm(array, i) {
  let copy = array.slice()
  copy.splice(i, 1)
  return copy
}

function maybeSpaceBefore(node, graph) {
  let withSpace = graph.curRule.space
  if (!withSpace) return node
  let space = graph.getRule(withSpace), before = graph.node()
  graph.edge(before, space.start, null, [new CallEffect(withSpace, node)])
  return before
}

function callRule(start, end, name, graph) {
  graph.edge(start, graph.getRule(name).start, null, [new CallEffect(name, end)])
}

function generateExpr(start, end, expr, graph) {
  let t = expr.type
  if (t == "CharacterRange") {
    graph.edge(start, end, new RangeMatch(expr.from, expr.to))
  } else if (t == "StringMatch") {
    let separated = expr.value.split(/\n\r?|\r/)
    for (let i = 0; i < separated.length - 1; i++) {
      let line = separated[i]
      if (line) {
        let after = graph.node()
        graph.edge(start, after, new StringMatch(line))
        start = after
      }
      let after = graph.node()
      graph.edge(start, after, new StringMatch("\n"))
      start = after
    }
    let last = separated[separated.length - 1]
    graph.edge(start, end, last ? new StringMatch(last) : nullMatch)
  } else if (t == "AnyMatch") {
    graph.edge(start, end, anyMatch)
  } else if (t == "RuleIdentifier") {
    callRule(start, end, expr.id.name, graph)
  } else if (t == "RepeatedMatch") {
    if (expr.kind == "*") {
      graph.edge(start, end)
      generateExpr(end, maybeSpaceBefore(end, graph), expr.expr, graph)
    } else if (expr.kind == "+") {
      generateExpr(start, maybeSpaceBefore(end, graph), expr.expr, graph)
      generateExpr(end, maybeSpaceBefore(end, graph), expr.expr, graph)
    } else if (expr.kind == "?") {
      generateExpr(start, end, expr.expr, graph)
      graph.edge(start, end)
    }
  } else if (t == "LookaheadMatch") {
    let before = graph.node(null, "lookahead"), after = graph.node(null, "lookahead_end")
    generateExpr(before, after, expr.expr, graph)
    graph.edge(after, null, null, [returnEffect])
    graph.edge(start, end, new LookaheadMatch(before, t.kind == "~"))
  } else if (t == "SequenceMatch") {
    for (let i = 0; i < expr.exprs.length; i++) {
      let next = end, to = next, cur = expr.exprs[i]
      if (i < expr.exprs.length - 1) {
        next = graph.node()
        to = maybeSpaceBefore(next, graph)
      }
      generateExpr(start, to, cur, graph)
      start = next
    }
  } else if (t == "ChoiceMatch") {
    for (let i = 0; i < expr.exprs.length; i++)
      generateExpr(start, end, expr.exprs[i], graph)
  } else {
    throw new Error("Unrecognized AST node type " + t)
  }
}

function lastCall(effects) {
  for (let i = effects.length - 1; i >= 0; i--)
    if (effects[i] instanceof CallEffect) return i
  return -1
}

function simplifySequence(graph, node, edges) {
  outer: for (let i = 0; i < edges.length; i++) {
    let first = edges[i]
    if (first.to == node || first.to == graph.rules.START.start || !first.to) continue
    let next = graph.nodes[first.to]
    if (next.length == 0) continue
    if (next.length == 0 ||
        next.length > 1 && graph.countIncoming(first.to) > 1 && edges.length == 1) continue
    let newEdges = []
    for (let j = 0; j < next.length; j++) {
      let second = next[j], end = second.to, effects
      if (end == first.to ||
          (!first.match.isNull && (second.match.isolated || second.effects.some(e => e instanceof PushContext))) ||
          (!second.match.isNull && (first.match.isolated || first.effects.indexOf(popContext) > -1)))
        continue outer
      // If second is a return edge
      if (!end) {
        let last = lastCall(first.effects)
        if (last > -1 && !graph.rules[first.effects[last].rule].context) {
          // Matching non-context call found, wire directly to return address, remove call/return effects
          end = first.effects[last].returnTo
          effects = rm(first.effects, last).concat(second.effects.filter(e => e != returnEffect))
        }
      }
      if (!effects) effects = first.effects.concat(second.effects)
      newEdges.push(new Edge(end, SeqMatch.create(first.match, second.match), effects))
    }
    edges.splice(i, 1, ...newEdges)
    i += newEdges.length - 1
    return true
  }
  return false
}

function sameEffect(edge1, edge2) {
  let e1 = edge1.effects, e2 = edge2.effects
  if (e1.length != e2.length) return false
  for (let i = 0; i < e1.length; i++)
    if (!e1[i].eq(e2[i])) return false
  return true
}

function simplifyChoice(graph, node, edges) {
  for (let i = 0; i < edges.length; i++) {
    let edge = edges[i], set
    if (edge.match.isNull || edge.match.isolated) continue
    for (let j = i + 1; j < edges.length; j++) {
      let other = edges[j]
      if (other.to == edge.to && sameEffect(edge, other) && !other.match.isNull && !other.match.isolated)
        (set || (set = [edge])).push(other)
    }
    if (set) {
      let match = set[0].match
      for (let j = 1; j < set.length; j++)
        match = ChoiceMatch.create(match, set[j].match)
      graph.nodes[node] = edges.filter(e => set.indexOf(e) == -1).concat(new Edge(edge.to, match, edge.effects))
      return true
    }
  }
  return false
}

function simplifyRepeat(graph, node, edges) {
  if (node == graph.rules.START.start) return
  let cycleIndex, cycleEdge
  for (let i = 0; i < edges.length; i++) {
    let edge = edges[i]
    if (edge.to == node && !edge.match.isolated && !edge.isNull) {
      if (cycleEdge) return false
      cycleIndex = i
      cycleEdge = edge
    }
  }
  if (!cycleEdge || cycleEdge.effects.length) return false
  let newNode = graph.node(node, "split")
  graph.nodes[newNode] = rm(edges, cycleIndex)
  graph.nodes[node] = [new Edge(newNode, new RepeatMatch(cycleEdge.match), cycleEdge.effects)]
  return true
}

function simplifyLookahead(graph, _node, edges) {
  for (let i = 0; i < edges.length; i++) {
    let edge = edges[i]
    if (!(edge.match instanceof LookaheadMatch)) continue
    let out = graph.nodes[edge.match.start]
    if (out.length != 1 || out[0].to || out[0].match.isolated) continue
    edges[i] = new Edge(edge.to, new SimpleLookaheadMatch(out[0].match, edge.match.positive), edge.effects)
    return true
  }
}

function isCalledOnlyOnce(graph, node) {
  let localNodes = [node], returnNodes = [], workIndex = 0
  while (workIndex < localNodes.length) {
    let cur = localNodes[workIndex++], edges = graph.nodes[cur]
    for (let i = 0; i < edges.length; i++) {
      let to = edges[i].to
      if (!to) returnNodes.push(cur)
      else if (localNodes.indexOf(to) == -1) localNodes.push(to)
    }
  }

  let called = 0
  graph.forEachRef((from, to, type) => {
    if (to != node || localNodes.indexOf(from) > -1) return
    called += (type == "edge" ? 1 : 100)
  })
  return called == 1 && returnNodes.length ? returnNodes : null
}

function simplifyCall(graph, _node, edges) {
  for (let i = 0; i < edges.length; i++) {
    let edge = edges[i], last = true
    for (let j = edge.effects.length - 1; j >= 0; j--) {
      let effect = edge.effects[j], returnNodes
      if (!(effect instanceof CallEffect)) continue
      if (last && (returnNodes = isCalledOnlyOnce(graph, edge.to))) { // FIXME this is very quadratic
        edges[i] = new Edge(edge.to, edge.match, rm(edge.effects, j))
        for (let k = 0; k < returnNodes.length; k++) {
          let edges = graph.nodes[returnNodes[k]]
          for (let l = 0; l < edges.length; l++) {
            let edge = edges[l]
            if (!edge.to) edges[l] = new Edge(effect.returnTo, edge.match, edge.effects.filter(e => e != returnEffect))
          }
        }
        return true
      }
      let out = graph.nodes[effect.returnTo]
      if (out.length != 1) continue
      let after = out[0]
      if (after.match != nullMatch) continue
      if (last && after.effects.length == 1 && after.effects[0] == returnEffect &&
          !graph.rules[effect.rule].context) {
        // Change tail call to direct connection
        edges[i] = new Edge(edge.to, edge.match, rm(edge.effects, j))
        return true
      } else if (after.effects.length == 0) {
        // Erase a null edge after a call
        edge.effects[j] = new CallEffect(effect.rule, after.to)
        return true
      }
      last = false
    }
  }
}

// Look for simplification possibilities around the given node, return
// true if anything was done
function simplifyWith(graph, simplifiers) {
  let changed = false
  for (let node in graph.nodes) {
    let edges = graph.nodes[node]
    for (let i = 0; i < simplifiers.length; i++) if (simplifiers[i](graph, node, edges)) {
      changed = true
      break
    }
  }
  return changed
}

function simplify(graph) {
  do {
    graph.gc()
    mergeDuplicates(graph)
  } while (simplifyWith(graph, [
    simplifyChoice,
    simplifyRepeat,
    simplifySequence,
    simplifyLookahead,
    simplifyCall
  ]))
}

function mergeDuplicates(graph) {
  outer: for (;;) {
    let names = Object.keys(graph.nodes)
    for (let i = 0; i < names.length; i++) {
      let name = names[i], edges = graph.nodes[name]
      for (let j = i + 1; j < names.length; j++) {
        let otherName = names[j]
        if (eqArray(edges, graph.nodes[otherName])) {
          if (otherName == "_TOKEN") { let tmp = name; name = otherName; otherName = tmp }
          graph.merge(name, otherName)
          continue outer
        }
      }
    }
    break
  }
}

exports.buildGraph = function(grammar) {
  let graph = new Graph(grammar)
  simplify(graph)
  return graph
}
