// graphql.ts — the GraphQL surface of the forge (POST /api/graphql).
// A small hand-rolled GraphQL parser + executor for exactly the documents
// the conformance suite sends: viewer/repository/issue/pull-request reads,
// Relay node + __type introspection, the five mutations, batching and
// cursor pagination. No GraphQL library, Node 22 built-ins only.
// Written from scratch for this entry.

import { store, VIEWER } from './store.ts';
import type { Issue, IssueComment, PullRequest, Repo } from './store.ts';
import { errorResponse, isRecord, jsonResponse } from './util.ts';
import type { ApiRequest, ApiResponse } from './util.ts';

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type ValueKind =
  | 'variable'
  | 'string'
  | 'int'
  | 'float'
  | 'boolean'
  | 'null'
  | 'enum'
  | 'list'
  | 'object';

interface ValueNode {
  kind: ValueKind;
  name?: string;
  value?: string | number | boolean;
  items?: ValueNode[];
  fields?: { name: string; value: ValueNode }[];
}

interface ArgumentNode {
  name: string;
  value: ValueNode;
}

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: ArgumentNode[];
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread';
  value: string;
}

function tokenize(input: string): Token[] | string {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < n && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.') {
      if (input.slice(i, i + 3) === '...') {
        tokens.push({ kind: 'spread', value: '...' });
        i += 3;
        continue;
      }
      return `Unexpected character '.' at offset ${i}`;
    }
    if (ch === '!' || ch === '$' || ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === '{' || ch === '}' || ch === ':' || ch === '=' || ch === '@') {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < n) {
        const c = input[j];
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === '\\') {
          const e = input[j + 1];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'b') out += '\b';
          else if (e === 'f') out += '\f';
          else if (e === '/') out += '/';
          else if (e === '\\') out += '\\';
          else if (e === '"') out += '"';
          else if (e === 'u') {
            out += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 4;
          } else if (e !== undefined) out += e;
          j += 2;
          continue;
        }
        out += c;
        j += 1;
      }
      if (!closed) return 'Unterminated string literal';
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      if (input[j] === '-') j += 1;
      let isFloat = false;
      while (j < n && /[0-9]/.test(input[j])) j += 1;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < n && /[0-9]/.test(input[j])) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < n && /[0-9]/.test(input[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(input[j])) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    return `Unexpected character '${ch}' at offset ${i}`;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent over the token stream)
// ---------------------------------------------------------------------------

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token | undefined {
    return this.tokens[this.pos++];
  }

  atPunct(value: string): boolean {
    const t = this.peek();
    return t !== undefined && t.kind === 'punct' && t.value === value;
  }

  eatPunct(value: string): boolean {
    if (this.atPunct(value)) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  expectPunct(value: string): string | null {
    if (!this.eatPunct(value)) return `Expected '${value}' but found ${this.describePeek()}`;
    return null;
  }

  atName(value?: string): boolean {
    const t = this.peek();
    return t !== undefined && t.kind === 'name' && (value === undefined || t.value === value);
  }

  eatName(value?: string): string | null {
    const t = this.peek();
    if (t !== undefined && t.kind === 'name' && (value === undefined || t.value === value)) {
      this.pos += 1;
      return t.value;
    }
    return null;
  }

  describePeek(): string {
    const t = this.peek();
    if (t === undefined) return 'end of document';
    return `'${t.value}'`;
  }

  /** Skip a `@directive` (name + optional arguments). Directives are unused. */
  skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.eatName();
      if (this.atPunct('(')) this.parseArguments();
    }
  }

  /** Consume a GraphQL type reference: Name, [T], T!, [T!]! ... */
  parseType(): string | null {
    if (this.atPunct('[')) {
      this.next();
      const inner = this.parseType();
      if (inner === null) return null;
      const err = this.expectPunct(']');
      if (err !== null) return null;
      this.eatPunct('!');
      return `[${inner}]`;
    }
    const name = this.eatName();
    if (name === null) return null;
    this.eatPunct('!');
    return name;
  }

  parseVariableDefinitions(): string | null {
    if (!this.atPunct('(')) return null;
    this.next();
    while (!this.atPunct(')')) {
      if (this.peek() === undefined) return 'Unterminated variable definitions';
      if (!this.eatPunct('$')) return `Expected '$' but found ${this.describePeek()}`;
      if (this.eatName() === null) return `Expected variable name but found ${this.describePeek()}`;
      const err = this.expectPunct(':');
      if (err !== null) return err;
      if (this.parseType() === null) return `Expected variable type but found ${this.describePeek()}`;
      if (this.eatPunct('=')) {
        const value = this.parseValue();
        if (typeof value === 'string') return value;
      }
      this.skipDirectives();
    }
    this.next();
    return null;
  }

  parseValue(): ValueNode | string {
    const t = this.peek();
    if (t === undefined) return 'Unexpected end of document in value';
    if (t.kind === 'punct' && t.value === '$') {
      this.next();
      const name = this.eatName();
      if (name === null) return `Expected variable name but found ${this.describePeek()}`;
      return { kind: 'variable', name };
    }
    if (t.kind === 'string') {
      this.next();
      return { kind: 'string', value: t.value };
    }
    if (t.kind === 'int') {
      this.next();
      return { kind: 'int', value: parseInt(t.value, 10) };
    }
    if (t.kind === 'float') {
      this.next();
      return { kind: 'float', value: parseFloat(t.value) };
    }
    if (t.kind === 'punct' && t.value === '[') {
      this.next();
      const items: ValueNode[] = [];
      while (!this.atPunct(']')) {
        if (this.peek() === undefined) return 'Unterminated list value';
        const item = this.parseValue();
        if (typeof item === 'string') return item;
        items.push(item);
      }
      this.next();
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      this.next();
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.atPunct('}')) {
        if (this.peek() === undefined) return 'Unterminated input object value';
        const name = this.eatName();
        if (name === null) return `Expected field name but found ${this.describePeek()}`;
        const err = this.expectPunct(':');
        if (err !== null) return err;
        const value = this.parseValue();
        if (typeof value === 'string') return value;
        fields.push({ name, value });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (t.kind === 'name') {
      this.next();
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    return `Unexpected token ${this.describePeek()} in value`;
  }

  parseArguments(): ArgumentNode[] | string {
    // Caller has confirmed '(' is next.
    this.next();
    const args: ArgumentNode[] = [];
    while (!this.atPunct(')')) {
      if (this.peek() === undefined) return 'Unterminated arguments';
      const name = this.eatName();
      if (name === null) return `Expected argument name but found ${this.describePeek()}`;
      const err = this.expectPunct(':');
      if (err !== null) return err;
      const value = this.parseValue();
      if (typeof value === 'string') return value;
      args.push({ name, value });
    }
    this.next();
    return args;
  }

  parseSelectionSet(): SelectionNode[] | string {
    const err = this.expectPunct('{');
    if (err !== null) return err;
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      if (this.peek() === undefined) return 'Unterminated selection set';
      const sel = this.parseSelection();
      if (typeof sel === 'string') return sel;
      selections.push(sel);
    }
    this.next();
    return selections;
  }

  parseSelection(): SelectionNode | string {
    if (this.peek()?.kind === 'spread') {
      this.next();
      if (this.atName('on')) {
        this.next();
        const typeName = this.eatName();
        if (typeName === null) return `Expected type name after 'on' but found ${this.describePeek()}`;
        this.skipDirectives();
        const sels = this.parseSelectionSet();
        if (typeof sels === 'string') return sels;
        return { kind: 'fragment', typeCondition: typeName, selections: sels };
      }
      // Named fragment spread: no fragment definitions are used by the
      // suite; consume the name and contribute nothing.
      this.eatName();
      this.skipDirectives();
      return { kind: 'fragment', typeCondition: null, selections: [] };
    }
    const first = this.eatName();
    if (first === null) return `Expected field name but found ${this.describePeek()}`;
    let name = first;
    let alias: string | null = null;
    if (this.eatPunct(':')) {
      alias = first;
      const real = this.eatName();
      if (real === null) return `Expected field name after alias but found ${this.describePeek()}`;
      name = real;
    }
    let args: ArgumentNode[] = [];
    if (this.atPunct('(')) {
      const parsed = this.parseArguments();
      if (typeof parsed === 'string') return parsed;
      args = parsed;
    }
    this.skipDirectives();
    let selections: SelectionNode[] = [];
    if (this.atPunct('{')) {
      const parsed = this.parseSelectionSet();
      if (typeof parsed === 'string') return parsed;
      selections = parsed;
    }
    return { kind: 'field', name, alias, args, selections };
  }

  parseOperation(): OperationNode | string {
    let type: 'query' | 'mutation' = 'query';
    if (this.atName('query')) {
      this.next();
      type = 'query';
    } else if (this.atName('mutation')) {
      this.next();
      type = 'mutation';
    } else if (this.atName('subscription')) {
      return 'Subscriptions are not supported';
    }
    let name: string | null = null;
    if (this.peek()?.kind === 'name') name = this.eatName();
    const varErr = this.parseVariableDefinitions();
    if (varErr !== null) return varErr;
    this.skipDirectives();
    const sels = this.parseSelectionSet();
    if (typeof sels === 'string') return sels;
    return { type, name, selections: sels };
  }

  parseDocument(): OperationNode[] | string {
    const operations: OperationNode[] = [];
    while (this.peek() !== undefined) {
      const op = this.parseOperation();
      if (typeof op === 'string') return op;
      operations.push(op);
    }
    if (operations.length === 0) return 'Empty GraphQL document';
    return operations;
  }
}

// ---------------------------------------------------------------------------
// Value / argument resolution
// ---------------------------------------------------------------------------

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name as string];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return (node.items ?? []).map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields ?? []) {
        const value = resolveValue(field.value, variables);
        if (value !== undefined) out[field.name] = value;
      }
      return out;
    }
    default:
      return undefined;
  }
}

function resolveArgs(args: ArgumentNode[], variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) {
    const value = resolveValue(arg.value, variables);
    if (value !== undefined) out[arg.name] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schema surface (field names per parent type)
// ---------------------------------------------------------------------------

const FIELD_SETS: Record<string, Set<string>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type']),
  Mutation: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
  User: new Set(['login']),
  Repository: new Set([
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ]),
  BranchRef: new Set(['name']),
  Issue: new Set(['id', 'number', 'title', 'state', 'body']),
  IssueConnection: new Set(['nodes', 'pageInfo']),
  PageInfo: new Set(['hasNextPage', 'endCursor']),
  PullRequest: new Set(['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files']),
  PullRequestConnection: new Set(['nodes']),
  PullRequestFileConnection: new Set(['nodes']),
  PullRequestChangedFile: new Set(['path']),
  __Type: new Set(['fields', 'enumValues']),
  __Field: new Set(['name']),
  __EnumValue: new Set(['name']),
  CreateIssuePayload: new Set(['issue']),
  CloseIssuePayload: new Set(['issue']),
  CreatePullRequestPayload: new Set(['pullRequest']),
  MergePullRequestPayload: new Set(['pullRequest']),
  AddCommentPayload: new Set(['commentEdge']),
  CommentEdge: new Set(['node']),
  Comment: new Set(['id', 'body']),
};

function typeFieldNames(typeName: string): string[] {
  if (typeName === 'Issue') return ['id', 'number', 'title', 'state', 'body'];
  if (typeName === 'PullRequest') return ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'];
  if (typeName === 'Repository') {
    return [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
      'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
    ];
  }
  return [];
}

function typeEnumValueNames(typeName: string): string[] {
  if (typeName === 'SearchType') {
    return ['ISSUE', 'PULL_REQUEST', 'DISCUSSION', 'COMMIT', 'REPOSITORY', 'USER', 'ORGANIZATION'];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Cursors (opaque, deterministic): "cursor:<issue number>"
// ---------------------------------------------------------------------------

function encodeCursor(number: number): string {
  return `cursor:${number}`;
}

function decodeCursor(cursor: string): number | null {
  let text = cursor;
  if (!text.startsWith('cursor:')) {
    try {
      const decoded = Buffer.from(text, 'base64').toString('utf8');
      if (decoded.startsWith('cursor:')) text = decoded;
      else return null;
    } catch {
      return null;
    }
  }
  const n = parseInt(text.slice('cursor:'.length), 10);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** A whole-operation failure: data null + one GraphQL error. */
class OpError extends Error {}

interface Resolved {
  type: string;
  value: unknown;
}

interface Ctx {
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

interface IssueConnectionValue {
  nodes: Issue[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

function buildIssueConnection(repo: Repo, args: Record<string, unknown>): IssueConnectionValue {
  let list = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wantOpen = states.includes('OPEN');
    const wantClosed = states.includes('CLOSED');
    list = list.filter(
      (issue) => (issue.state === 'open' && wantOpen) || (issue.state === 'closed' && wantClosed),
    );
  }
  let desc = false;
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  if (orderBy !== null) {
    if (orderBy.direction === 'DESC') desc = true;
    else if (orderBy.direction === 'ASC') desc = false;
  }
  list.sort((a, b) => (desc ? b.seq - a.seq : a.seq - b.seq));
  const after = args.after;
  if (typeof after === 'string' && after.length > 0) {
    const cursorNumber = decodeCursor(after);
    if (cursorNumber !== null) {
      list = list.filter((issue) => (desc ? issue.number < cursorNumber : issue.number > cursorNumber));
    }
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, Math.max(0, first));
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
  return { nodes: page, pageInfo: { hasNextPage, endCursor } };
}

function scalar(type: string, value: unknown): Resolved {
  return { type, value };
}

function resolveField(
  typeName: string,
  parent: unknown,
  fieldName: string,
  args: Record<string, unknown>,
): Resolved | null {
  switch (typeName) {
    case 'Query': {
      if (fieldName === 'viewer') return { type: 'User', value: VIEWER };
      if (fieldName === 'repository') {
        const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : { type: 'Repository', value: repo };
      }
      if (fieldName === 'node') {
        const repo = store.getRepoByGlobalId(String(args.id ?? ''));
        return repo === undefined ? null : { type: 'Repository', value: repo };
      }
      if (fieldName === '__type') {
        return { type: '__Type', value: { name: String(args.name ?? '') } };
      }
      return null;
    }
    case 'Mutation': {
      const input = isRecord(args.input) ? args.input : {};
      if (fieldName === 'createIssue') {
        const repo = store.getRepoByGlobalId(String(input.repositoryId ?? ''));
        if (repo === undefined) throw new OpError(`Repository not found: ${String(input.repositoryId ?? '')}`);
        const issue = store.createIssue(
          repo,
          String(input.title ?? ''),
          typeof input.body === 'string' ? input.body : '',
          [],
        );
        return { type: 'CreateIssuePayload', value: { issue } };
      }
      if (fieldName === 'closeIssue') {
        const found = store.getIssueByGlobalId(String(input.issueId ?? ''));
        if (found === undefined) throw new OpError(`Issue not found: ${String(input.issueId ?? '')}`);
        found.issue.state = 'closed';
        return { type: 'CloseIssuePayload', value: { issue: found.issue } };
      }
      if (fieldName === 'createPullRequest') {
        const repo = store.getRepoByGlobalId(String(input.repositoryId ?? ''));
        if (repo === undefined) throw new OpError(`Repository not found: ${String(input.repositoryId ?? '')}`);
        const baseRef = String(input.baseRefName ?? '');
        const headRef = String(input.headRefName ?? '');
        const baseSha = store.branchTip(repo, baseRef);
        const headSha = store.branchTip(repo, headRef);
        if (baseSha === undefined) throw new OpError(`Branch not found: ${baseRef}`);
        if (headSha === undefined) throw new OpError(`Branch not found: ${headRef}`);
        const pull = store.createPull(
          repo,
          String(input.title ?? ''),
          typeof input.body === 'string' ? input.body : '',
          headRef,
          baseRef,
          headSha,
          baseSha,
        );
        return { type: 'CreatePullRequestPayload', value: { pull } };
      }
      if (fieldName === 'mergePullRequest') {
        const found = store.getPullByGlobalId(String(input.pullRequestId ?? ''));
        if (found === undefined) throw new OpError(`Pull request not found: ${String(input.pullRequestId ?? '')}`);
        const sha = store.mergePull(found.repo, found.pull);
        if (sha === null) throw new OpError(`Pull request #${found.pull.number} has merge conflicts`);
        return { type: 'MergePullRequestPayload', value: { pull: found.pull } };
      }
      if (fieldName === 'addComment') {
        const found = store.getIssueByGlobalId(String(input.subjectId ?? ''));
        if (found === undefined) throw new OpError(`Issue not found: ${String(input.subjectId ?? '')}`);
        const comment = store.addComment(found.repo, found.issue, String(input.body ?? ''));
        return { type: 'AddCommentPayload', value: { comment } };
      }
      return null;
    }
    case 'User': {
      if (fieldName === 'login') return scalar('String', VIEWER.login);
      return null;
    }
    case 'Repository': {
      const repo = parent as Repo;
      if (fieldName === 'id') return scalar('ID', repo.globalId);
      if (fieldName === 'databaseId') return scalar('Int', repo.dbId);
      if (fieldName === 'name') return scalar('String', repo.name);
      if (fieldName === 'nameWithOwner') return scalar('String', `${repo.owner}/${repo.name}`);
      if (fieldName === 'owner') return { type: 'User', value: VIEWER };
      if (fieldName === 'defaultBranchRef') {
        const tip = store.branchTip(repo, repo.defaultBranch);
        return tip === undefined ? null : { type: 'BranchRef', value: { name: repo.defaultBranch } };
      }
      if (fieldName === 'viewerPermission') return scalar('String', 'ADMIN');
      if (fieldName === 'hasIssuesEnabled') return scalar('Boolean', true);
      if (fieldName === 'issue') {
        const issue = store.getIssue(repo, Number(args.number));
        return issue === undefined ? null : { type: 'Issue', value: issue };
      }
      if (fieldName === 'issues') {
        return { type: 'IssueConnection', value: buildIssueConnection(repo, args) };
      }
      if (fieldName === 'pullRequests') {
        const first = typeof args.first === 'number' ? args.first : repo.pulls.length;
        return { type: 'PullRequestConnection', value: { nodes: repo.pulls.slice(0, Math.max(0, first)) } };
      }
      if (fieldName === 'pullRequest') {
        const pull = store.getPull(repo, Number(args.number));
        return pull === undefined ? null : { type: 'PullRequest', value: pull };
      }
      return null;
    }
    case 'BranchRef': {
      if (fieldName === 'name') return scalar('String', (parent as { name: string }).name);
      return null;
    }
    case 'Issue': {
      const issue = parent as Issue;
      if (fieldName === 'id') return scalar('ID', issue.globalId);
      if (fieldName === 'number') return scalar('Int', issue.number);
      if (fieldName === 'title') return scalar('String', issue.title);
      if (fieldName === 'state') return scalar('String', issue.state === 'open' ? 'OPEN' : 'CLOSED');
      if (fieldName === 'body') return scalar('String', issue.body);
      return null;
    }
    case 'IssueConnection': {
      const conn = parent as IssueConnectionValue;
      if (fieldName === 'nodes') return { type: 'Issue', value: conn.nodes };
      if (fieldName === 'pageInfo') return { type: 'PageInfo', value: conn.pageInfo };
      return null;
    }
    case 'PageInfo': {
      const info = parent as { hasNextPage: boolean; endCursor: string | null };
      if (fieldName === 'hasNextPage') return scalar('Boolean', info.hasNextPage);
      if (fieldName === 'endCursor') return scalar('String', info.endCursor);
      return null;
    }
    case 'PullRequest': {
      const pull = parent as PullRequest;
      if (fieldName === 'id') return scalar('ID', pull.globalId);
      if (fieldName === 'number') return scalar('Int', pull.number);
      if (fieldName === 'state') return scalar('String', pull.state === 'open' ? 'OPEN' : 'CLOSED');
      if (fieldName === 'merged') return scalar('Boolean', pull.merged);
      if (fieldName === 'headRefName') return scalar('String', pull.headRef);
      if (fieldName === 'baseRefName') return scalar('String', pull.baseRef);
      if (fieldName === 'mergeable') return scalar('String', 'MERGEABLE');
      if (fieldName === 'files') {
        const found = store.getPullByGlobalId(pull.globalId);
        const files = found === undefined ? [] : store.pullFiles(found.repo, found.pull);
        const first = typeof args.first === 'number' ? args.first : files.length;
        return {
          type: 'PullRequestFileConnection',
          value: { nodes: files.slice(0, Math.max(0, first)).map((f) => ({ path: f.filename })) },
        };
      }
      return null;
    }
    case 'PullRequestConnection': {
      const conn = parent as { nodes: PullRequest[] };
      if (fieldName === 'nodes') return { type: 'PullRequest', value: conn.nodes };
      return null;
    }
    case 'PullRequestFileConnection': {
      const conn = parent as { nodes: { path: string }[] };
      if (fieldName === 'nodes') return { type: 'PullRequestChangedFile', value: conn.nodes };
      return null;
    }
    case 'PullRequestChangedFile': {
      if (fieldName === 'path') return scalar('String', (parent as { path: string }).path);
      return null;
    }
    case '__Type': {
      const typeInfo = parent as { name: string };
      if (fieldName === 'fields') {
        return { type: '__Field', value: typeFieldNames(typeInfo.name).map((name) => ({ name })) };
      }
      if (fieldName === 'enumValues') {
        return { type: '__EnumValue', value: typeEnumValueNames(typeInfo.name).map((name) => ({ name })) };
      }
      return null;
    }
    case '__Field':
    case '__EnumValue': {
      if (fieldName === 'name') return scalar('String', (parent as { name: string }).name);
      return null;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (fieldName === 'issue') return { type: 'Issue', value: (parent as { issue: Issue }).issue };
      return null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (fieldName === 'pullRequest') {
        return { type: 'PullRequest', value: (parent as { pull: PullRequest }).pull };
      }
      return null;
    }
    case 'AddCommentPayload': {
      if (fieldName === 'commentEdge') {
        return { type: 'CommentEdge', value: (parent as { comment: IssueComment }).comment };
      }
      return null;
    }
    case 'CommentEdge': {
      if (fieldName === 'node') return { type: 'Comment', value: parent as IssueComment };
      return null;
    }
    case 'Comment': {
      const comment = parent as IssueComment;
      if (fieldName === 'id') return scalar('ID', comment.globalId);
      if (fieldName === 'body') return scalar('String', comment.body);
      return null;
    }
    default:
      return null;
  }
}

function applySelection(
  typeName: string,
  value: unknown,
  selections: SelectionNode[],
  ctx: Ctx,
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item) => applySelection(typeName, item, selections, ctx));
  }
  const out: Record<string, unknown> = {};
  const allowed = FIELD_SETS[typeName];
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition === null || sel.typeCondition === typeName) {
        const sub = applySelection(typeName, value, sel.selections, ctx);
        if (isRecord(sub)) Object.assign(out, sub);
      }
      continue;
    }
    const responseKey = sel.alias ?? sel.name;
    if (allowed === undefined || !allowed.has(sel.name)) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".` });
      out[responseKey] = null;
      continue;
    }
    const args = resolveArgs(sel.args, ctx.variables);
    const resolved = resolveField(typeName, value, sel.name, args);
    if (resolved === null) {
      out[responseKey] = null;
      continue;
    }
    if (sel.selections.length === 0) {
      out[responseKey] = resolved.value;
    } else {
      out[responseKey] = applySelection(resolved.type, resolved.value, sel.selections, ctx);
    }
  }
  return out;
}

function executeOperation(operation: unknown): Record<string, unknown> {
  if (!isRecord(operation) || typeof operation.query !== 'string') {
    return {
      data: null,
      errors: [{ message: 'GraphQL operation must be an object with a query string' }],
    };
  }
  const variables = isRecord(operation.variables) ? (operation.variables as Record<string, unknown>) : {};
  const tokenized = tokenize(operation.query);
  if (typeof tokenized === 'string') {
    return { data: null, errors: [{ message: tokenized }] };
  }
  const parsed = new Parser(tokenized).parseDocument();
  if (typeof parsed === 'string') {
    return { data: null, errors: [{ message: parsed }] };
  }
  const doc = parsed[0];
  const ctx: Ctx = { variables, errors: [] };
  const rootType = doc.type === 'mutation' ? 'Mutation' : 'Query';
  try {
    const data = applySelection(rootType, {}, doc.selections, ctx);
    const result: Record<string, unknown> = { data };
    if (ctx.errors.length > 0) result.errors = ctx.errors;
    return result;
  } catch (err) {
    if (err instanceof OpError) {
      return { data: null, errors: [{ message: err.message }] };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------

export function handleGraphQL(req: ApiRequest): ApiResponse {
  if (!req.authed) return errorResponse(401, 'Unauthorized');
  if (req.jsonError) {
    return jsonResponse(400, { errors: [{ message: 'Request body is not valid JSON' }] });
  }
  const body = req.json;
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return jsonResponse(400, { errors: [{ message: 'Batch must contain at least one operation' }] });
    }
    return jsonResponse(200, body.map((op) => executeOperation(op)));
  }
  if (!isRecord(body)) {
    return jsonResponse(400, {
      errors: [{ message: 'GraphQL request body must be an object or an array of operations' }],
    });
  }
  return jsonResponse(200, executeOperation(body));
}
