// graphql.ts — a small, purpose-built GraphQL executor for the forge's schema: a
// recursive-descent parser for the documented query subset, a mini-schema for
// validation and introspection, and resolvers over the shared store. No dependencies.

import { Store, StoreError, VIEWER } from './store.ts';
import type { Issue, PullRequest, Repo } from './store.ts';
import { decodeGlobalId, encodeGlobalId } from './rest.ts';
import { jsonResult, parseJsonValue } from './httputil.ts';
import type { HttpResult, RequestInfo } from './httputil.ts';

// ---------------------------------------------------------------------------------------------
// AST and parser
// ---------------------------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface ArgumentNode {
  readonly name: string;
  readonly value: ValueNode;
}

export type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

export interface FieldNode {
  readonly kind: 'field';
  readonly alias: string | undefined;
  readonly name: string;
  readonly args: ArgumentNode[];
  readonly selections: SelectionNode[] | undefined;
}

export interface FragmentSpreadNode {
  readonly kind: 'fragmentSpread';
  readonly name: string;
}

export interface InlineFragmentNode {
  readonly kind: 'inlineFragment';
  readonly typeCondition: string | undefined;
  readonly selections: SelectionNode[];
}

export type TypeNode =
  | { kind: 'named'; name: string }
  | { kind: 'list'; ofType: TypeNode }
  | { kind: 'nonNull'; ofType: TypeNode };

export interface VariableDefinition {
  readonly name: string;
  readonly type: TypeNode;
  readonly defaultValue: ValueNode | undefined;
}

export interface OperationDefinition {
  readonly kind: 'operation';
  readonly operation: 'query' | 'mutation' | 'subscription';
  readonly name: string | undefined;
  readonly variables: VariableDefinition[];
  readonly selections: SelectionNode[];
}

export interface FragmentDefinition {
  readonly kind: 'fragment';
  readonly name: string;
  readonly typeCondition: string;
  readonly selections: SelectionNode[];
}

export type DefinitionNode = OperationDefinition | FragmentDefinition;

export class GraphQLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLError';
  }
}

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof'; value: '' };

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (token: Token): void => {
    tokens.push(token);
  };
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new GraphQLError('Unterminated block string');
        push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= source.length) throw new GraphQLError('Unterminated string');
        const c = source[j]!;
        if (c === '"') break;
        if (c === '\n') throw new GraphQLError('Unterminated string');
        if (c === '\\') {
          const esc = source[j + 1];
          if (esc === undefined) throw new GraphQLError('Unterminated string escape');
          const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            const hex = source.slice(j + 2, j + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new GraphQLError('Invalid unicode escape');
            value += String.fromCharCode(Number.parseInt(hex, 16));
            j += 6;
          } else if (simple[esc] !== undefined) {
            value += simple[esc];
            j += 2;
          } else {
            throw new GraphQLError(`Invalid string escape \\${esc}`);
          }
          continue;
        }
        value += c;
        j += 1;
      }
      push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (NAME_START.test(ch)) {
      let j = i + 1;
      while (j < source.length && NAME_CHAR.test(source[j]!)) j += 1;
      push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (DIGIT.test(ch) || (ch === '-' && DIGIT.test(source[i + 1] ?? ''))) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && DIGIT.test(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && DIGIT.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && DIGIT.test(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        let k = j + 1;
        if (source[k] === '+' || source[k] === '-') k += 1;
        if (DIGIT.test(source[k] ?? '')) {
          isFloat = true;
          j = k;
          while (j < source.length && DIGIT.test(source[j]!)) j += 1;
        }
      }
      const text = source.slice(i, j);
      push(isFloat ? { kind: 'float', value: text } : { kind: 'int', value: text });
      i = j;
      continue;
    }
    throw new GraphQLError(`Unexpected character ${JSON.stringify(ch)}`);
  }
  push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new GraphQLError(`Expected "${value}" but got ${token.kind === 'eof' ? 'end of query' : JSON.stringify(token.value)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new GraphQLError(`Expected a name but got ${JSON.stringify(token.value)}`);
    if (value !== undefined && token.value !== value) throw new GraphQLError(`Expected "${value}" but got "${token.value}"`);
    return token.value;
  }

  private skipIfPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.next();
      return true;
    }
    return false;
  }

  private peekName(value: string): boolean {
    const token = this.peek();
    return token.kind === 'name' && token.value === value;
  }

  parseDocument(): DefinitionNode[] {
    const definitions: DefinitionNode[] = [];
    while (this.peek().kind !== 'eof') definitions.push(this.parseDefinition());
    return definitions;
  }

  private parseDefinition(): DefinitionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', name: undefined, variables: [], selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      this.parseDirectives();
      return { kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      const operation = this.next().value as 'query' | 'mutation' | 'subscription';
      let name: string | undefined;
      if (this.peek().kind === 'name') name = this.next().value;
      const variables = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseVariableDefinitions() : [];
      this.parseDirectives();
      return { kind: 'operation', operation, name, variables, selections: this.parseSelectionSet() };
    }
    throw new GraphQLError(`Unexpected ${token.kind === 'eof' ? 'end of query' : JSON.stringify(token.value)}`);
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    this.expectPunct('(');
    const variables: VariableDefinition[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.skipIfPunct('=')) defaultValue = this.parseValue(true);
      this.parseDirectives();
      variables.push({ name, type, defaultValue });
    }
    this.expectPunct(')');
    return variables;
  }

  private parseType(): TypeNode {
    let type: TypeNode;
    if (this.skipIfPunct('[')) {
      type = { kind: 'list', ofType: this.parseType() };
      this.expectPunct(']');
    } else {
      type = { kind: 'named', name: this.expectName() };
    }
    if (this.skipIfPunct('!')) type = { kind: 'nonNull', ofType: type };
    return type;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new GraphQLError('Unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value !== 'on') {
        const name = this.next().value;
        this.parseDirectives();
        return { kind: 'fragmentSpread', name };
      }
      let typeCondition: string | undefined;
      if (this.peekName('on')) {
        this.next();
        typeCondition = this.expectName();
      }
      this.parseDirectives();
      return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.skipIfPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : [];
    this.parseDirectives();
    const selections = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : undefined;
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): ArgumentNode[] {
    this.expectPunct('(');
    const args: ArgumentNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue(false) });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(isConst: boolean): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$' && !isConst) {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue(isConst));
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new GraphQLError(`Unexpected value ${JSON.stringify(token.value)}`);
  }

  private parseDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }
}

export function parseGraphQL(source: string): DefinitionNode[] {
  return new Parser(tokenize(source)).parseDocument();
}

// ---------------------------------------------------------------------------------------------
// mini-schema: field lists for validation and introspection
// ---------------------------------------------------------------------------------------------

const OBJECT_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  PullRequestConnection: ['nodes'],
  PullRequestChangedFileConnection: ['nodes'],
  PullRequestChangedFile: ['path'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueCommentEdge: ['node'],
  IssueComment: ['id', 'body'],
  __Type: ['name', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
  Node: ['id'],
};

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'COMMIT', 'REPOSITORY', 'USER'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// Field return types (object types only; scalars need no recursion).
const FIELD_TYPE: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Repository: {
    owner: 'User',
    defaultBranchRef: 'Ref',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
  },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest' },
  PullRequest: { files: 'PullRequestChangedFileConnection' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  IssueCommentEdge: { node: 'IssueComment' },
  __Type: { fields: '__Field', enumValues: '__EnumValue' },
};

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

type GqlValue = Record<string, unknown> & { __typename?: string };

interface GqlContext {
  readonly store: Store;
  readonly variables: Record<string, unknown>;
  readonly variableDefs: VariableDefinition[];
  readonly fragments: Map<string, FragmentDefinition>;
  readonly errors: Array<{ message: string }>;
}

function coerceValue(node: ValueNode, ctx: GqlContext): unknown {
  switch (node.kind) {
    case 'variable': {
      const supplied = ctx.variables[node.name];
      if (supplied !== undefined) return supplied;
      const def = ctx.variableDefs.find((d) => d.name === node.name);
      return def?.defaultValue !== undefined ? coerceValue(def.defaultValue, ctx) : null;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => coerceValue(value, ctx));
    case 'object': {
      const object: Record<string, unknown> = {};
      for (const field of node.fields) object[field.name] = coerceValue(field.value, ctx);
      return object;
    }
  }
}

function coerceArgs(field: FieldNode, ctx: GqlContext): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = coerceValue(arg.value, ctx);
  return args;
}

function argString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function argInt(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function argObject(args: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const value = args[name];
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function argStringList(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

// ---------------------------------------------------------------------------------------------
// wrappers: resolved objects carry their concrete type plus private store handles
// ---------------------------------------------------------------------------------------------

function userWrapper(): GqlValue {
  return { __typename: 'User', login: VIEWER.login };
}

function repositoryWrapper(repo: Repo): GqlValue {
  return { __typename: 'Repository', __repo: repo };
}

function issueWrapper(repo: Repo, issue: Issue): GqlValue {
  return { __typename: 'Issue', __repo: repo, __issue: issue };
}

function pullRequestWrapper(repo: Repo, pr: PullRequest): GqlValue {
  return { __typename: 'PullRequest', __repo: repo, __pr: pr };
}

function repoOf(value: GqlValue): Repo {
  return value['__repo'] as Repo;
}

function issueOf(value: GqlValue): Issue {
  return value['__issue'] as Issue;
}

function prOf(value: GqlValue): PullRequest {
  return value['__pr'] as PullRequest;
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (!decoded.startsWith('cursor:')) return null;
  const value = Number.parseInt(decoded.slice('cursor:'.length), 10);
  return Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------------------------
// resolvers
// ---------------------------------------------------------------------------------------------

type Resolver = (parent: GqlValue, args: Record<string, unknown>, ctx: GqlContext) => unknown;

function resolveRepositoryById(store: Store, globalId: string): Repo | null {
  const decoded = decodeGlobalId(globalId);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const id = Number.parseInt(decoded.key, 10);
  if (!Number.isFinite(id)) return null;
  return store.listRepos().find((repo) => repo.id === id) ?? null;
}

const RESOLVERS: Record<string, Resolver> = {
  'Query.viewer': () => userWrapper(),
  'Query.repository': (_parent, args, ctx) => {
    const owner = argString(args, 'owner');
    const name = argString(args, 'name');
    if (owner === undefined || name === undefined) return null;
    if (owner.toLowerCase() !== VIEWER.login) return null;
    const repo = ctx.store.findRepo(name);
    return repo === undefined ? null : repositoryWrapper(repo);
  },
  'Query.node': (_parent, args, ctx) => {
    const id = argString(args, 'id');
    if (id === undefined) return null;
    const decoded = decodeGlobalId(id);
    if (decoded === null) return null;
    if (decoded.kind === 'Repository') {
      const repo = resolveRepositoryById(ctx.store, id);
      return repo === null ? null : repositoryWrapper(repo);
    }
    if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
      const [repoIdText, numberText] = decoded.key.split(':');
      const repoId = Number.parseInt(repoIdText ?? '', 10);
      const number = Number.parseInt(numberText ?? '', 10);
      if (!Number.isFinite(repoId) || !Number.isFinite(number)) return null;
      const repo = ctx.store.listRepos().find((candidate) => candidate.id === repoId);
      if (repo === undefined) return null;
      if (decoded.kind === 'Issue') {
        const issue = repo.issues.get(number);
        return issue === undefined ? null : issueWrapper(repo, issue);
      }
      const pr = repo.pullRequests.get(number);
      return pr === undefined ? null : pullRequestWrapper(repo, pr);
    }
    return null;
  },
  'Query.__type': (_parent, args) => {
    const name = argString(args, 'name');
    if (name === undefined) return null;
    if (OBJECT_FIELDS[name] === undefined && ENUM_VALUES[name] === undefined) return null;
    return { __typename: '__Type', name, __typeName: name };
  },
  '__Type.fields': (parent) => {
    const typeName = parent['__typeName'] as string;
    return (OBJECT_FIELDS[typeName] ?? []).map((name) => ({ __typename: '__Field', name }));
  },
  '__Type.enumValues': (parent) => {
    const typeName = parent['__typeName'] as string;
    return (ENUM_VALUES[typeName] ?? []).map((name) => ({ __typename: '__EnumValue', name }));
  },
  'Repository.id': (parent) => encodeGlobalId('Repository', String(repoOf(parent).id)),
  'Repository.databaseId': (parent) => repoOf(parent).id,
  'Repository.name': (parent) => repoOf(parent).name,
  'Repository.nameWithOwner': (parent) => `${repoOf(parent).ownerLogin}/${repoOf(parent).name}`,
  'Repository.description': (parent) => repoOf(parent).description,
  'Repository.owner': () => userWrapper(),
  'Repository.defaultBranchRef': (parent) => ({ __typename: 'Ref', name: repoOf(parent).defaultBranch }),
  'Repository.viewerPermission': () => 'ADMIN',
  'Repository.hasIssuesEnabled': () => true,
  'Repository.issue': (parent, args, ctx) => {
    const number = argInt(args, 'number');
    if (number === undefined) return null;
    const issue = ctx.store.listIssues(repoOf(parent)).find((candidate) => candidate.number === number);
    return issue === undefined ? null : issueWrapper(repoOf(parent), issue);
  },
  'Repository.issues': (parent, args, ctx) => {
    const repo = repoOf(parent);
    let issues = ctx.store.listIssues(repo);
    const states = argStringList(args, 'states');
    if (states !== undefined && states.length > 0) {
      const wanted = new Set(states.map((state) => state.toLowerCase()));
      issues = issues.filter((issue) => wanted.has(issue.state));
    }
    const orderBy = argObject(args, 'orderBy');
    const direction = orderBy !== undefined ? String(orderBy['direction'] ?? 'ASC') : 'ASC';
    issues = [...issues].sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
    const after = argString(args, 'after');
    if (after !== undefined && after !== null) {
      const cursorNumber = decodeCursor(after);
      if (cursorNumber !== null) {
        const index = issues.findIndex((issue) => issue.number === cursorNumber);
        if (index !== -1) issues = issues.slice(index + 1);
      }
    }
    const first = argInt(args, 'first');
    const total = issues.length;
    const page = first === undefined ? issues : issues.slice(0, first);
    const hasNextPage = first === undefined ? false : total > page.length;
    const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null;
    return {
      __typename: 'IssueConnection',
      nodes: page.map((issue) => issueWrapper(repo, issue)),
      pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
    };
  },
  'Repository.pullRequests': (parent, args, ctx) => {
    const repo = repoOf(parent);
    let prs = ctx.store.listPullRequests(repo).filter((pr) => pr.state === 'open');
    prs = [...prs].sort((a, b) => b.seq - a.seq);
    const first = argInt(args, 'first');
    if (first !== undefined) prs = prs.slice(0, first);
    return { __typename: 'PullRequestConnection', nodes: prs.map((pr) => pullRequestWrapper(repo, pr)) };
  },
  'Repository.pullRequest': (parent, args, ctx) => {
    const number = argInt(args, 'number');
    if (number === undefined) return null;
    const pr = ctx.store.listPullRequests(repoOf(parent)).find((candidate) => candidate.number === number);
    return pr === undefined ? null : pullRequestWrapper(repoOf(parent), pr);
  },
  'Issue.id': (parent) => encodeGlobalId('Issue', `${repoOf(parent).id}:${issueOf(parent).number}`),
  'Issue.number': (parent) => issueOf(parent).number,
  'Issue.title': (parent) => issueOf(parent).title,
  'Issue.state': (parent) => (issueOf(parent).state === 'open' ? 'OPEN' : 'CLOSED'),
  'Issue.body': (parent) => issueOf(parent).body,
  'PullRequest.id': (parent) => encodeGlobalId('PullRequest', `${repoOf(parent).id}:${prOf(parent).number}`),
  'PullRequest.number': (parent) => prOf(parent).number,
  'PullRequest.title': (parent) => prOf(parent).title,
  'PullRequest.body': (parent) => prOf(parent).body,
  'PullRequest.state': (parent) => {
    const pr = prOf(parent);
    if (pr.merged) return 'MERGED';
    return pr.state === 'open' ? 'OPEN' : 'CLOSED';
  },
  'PullRequest.merged': (parent) => prOf(parent).merged,
  'PullRequest.headRefName': (parent) => prOf(parent).headRef,
  'PullRequest.baseRefName': (parent) => prOf(parent).baseRef,
  'PullRequest.mergeable': (parent, _args, ctx) => {
    const pr = prOf(parent);
    if (pr.state !== 'open') return 'UNKNOWN';
    return ctx.store.isMergeable(repoOf(parent), pr) ? 'MERGEABLE' : 'CONFLICTING';
  },
  'PullRequest.files': (parent, args, ctx) => {
    const repo = repoOf(parent);
    const { changes } = ctx.store.diffPullRequest(repo, prOf(parent));
    const first = argInt(args, 'first');
    const page = first === undefined ? changes : changes.slice(0, first);
    return {
      __typename: 'PullRequestChangedFileConnection',
      nodes: page.map((change) => ({ __typename: 'PullRequestChangedFile', path: change.filename })),
    };
  },
  'Mutation.createIssue': (_parent, args, ctx) => {
    const input = argObject(args, 'input') ?? {};
    const repo = resolveRepositoryById(ctx.store, String(input['repositoryId'] ?? ''));
    if (repo === null) throw new StoreError(422, 'Repository not found');
    const title = String(input['title'] ?? '');
    const body = String(input['body'] ?? '');
    const issue = ctx.store.createIssue(repo, title, body, []);
    return { __typename: 'CreateIssuePayload', issue: issueWrapper(repo, issue), clientMutationId: input['clientMutationId'] ?? null };
  },
  'Mutation.closeIssue': (_parent, args, ctx) => {
    const input = argObject(args, 'input') ?? {};
    const decoded = decodeGlobalId(String(input['issueId'] ?? ''));
    if (decoded === null || decoded.kind !== 'Issue') throw new StoreError(422, 'Issue not found');
    const [repoIdText, numberText] = decoded.key.split(':');
    const repo = ctx.store.listRepos().find((candidate) => candidate.id === Number.parseInt(repoIdText ?? '', 10));
    const issue = repo?.issues.get(Number.parseInt(numberText ?? '', 10));
    if (repo === undefined || issue === undefined) throw new StoreError(422, 'Issue not found');
    issue.state = 'closed';
    issue.updatedAt = ctx.store.nowIso();
    return { __typename: 'CloseIssuePayload', issue: issueWrapper(repo, issue), clientMutationId: input['clientMutationId'] ?? null };
  },
  'Mutation.createPullRequest': (_parent, args, ctx) => {
    const input = argObject(args, 'input') ?? {};
    const repo = resolveRepositoryById(ctx.store, String(input['repositoryId'] ?? ''));
    if (repo === null) throw new StoreError(422, 'Repository not found');
    const title = String(input['title'] ?? '');
    const body = String(input['body'] ?? '');
    const headRefName = String(input['headRefName'] ?? '');
    const baseRefName = String(input['baseRefName'] ?? '');
    const pr = ctx.store.createPullRequest(repo, title, body, headRefName, baseRefName);
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullRequestWrapper(repo, pr), clientMutationId: input['clientMutationId'] ?? null };
  },
  'Mutation.mergePullRequest': (_parent, args, ctx) => {
    const input = argObject(args, 'input') ?? {};
    const decoded = decodeGlobalId(String(input['pullRequestId'] ?? ''));
    if (decoded === null || decoded.kind !== 'PullRequest') throw new StoreError(422, 'Pull request not found');
    const [repoIdText, numberText] = decoded.key.split(':');
    const repo = ctx.store.listRepos().find((candidate) => candidate.id === Number.parseInt(repoIdText ?? '', 10));
    const pr = repo?.pullRequests.get(Number.parseInt(numberText ?? '', 10));
    if (repo === undefined || pr === undefined) throw new StoreError(422, 'Pull request not found');
    ctx.store.mergePullRequest(repo, pr);
    return { __typename: 'MergePullRequestPayload', pullRequest: pullRequestWrapper(repo, pr), clientMutationId: input['clientMutationId'] ?? null };
  },
  'Mutation.addComment': (_parent, args, ctx) => {
    const input = argObject(args, 'input') ?? {};
    const decoded = decodeGlobalId(String(input['subjectId'] ?? ''));
    const body = String(input['body'] ?? '');
    if (decoded === null) throw new StoreError(422, 'Subject not found');
    const [repoIdText, numberText] = decoded.key.split(':');
    const repo = ctx.store.listRepos().find((candidate) => candidate.id === Number.parseInt(repoIdText ?? '', 10));
    if (repo === undefined) throw new StoreError(422, 'Subject not found');
    const number = Number.parseInt(numberText ?? '', 10);
    let commentId = 0;
    if (decoded.kind === 'Issue') {
      commentId = ctx.store.addIssueComment(repo, number, body).id;
    } else if (decoded.kind === 'PullRequest') {
      commentId = ctx.store.addPullRequestComment(repo, number, body).id;
    } else {
      throw new StoreError(422, 'Subject not found');
    }
    return {
      __typename: 'AddCommentPayload',
      commentEdge: {
        __typename: 'IssueCommentEdge',
        node: { __typename: 'IssueComment', id: encodeGlobalId('IssueComment', `${repo.id}:${commentId}`), body },
      },
      clientMutationId: input['clientMutationId'] ?? null,
    };
  },
};

function executeSelections(
  selections: readonly SelectionNode[],
  parentType: string,
  parentValue: GqlValue,
  ctx: GqlContext,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const effectiveType = parentValue.__typename ?? parentType;
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (fragment.typeCondition === effectiveType || fragment.typeCondition === parentType) {
        Object.assign(result, executeSelections(fragment.selections, parentType, parentValue, ctx));
      }
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (
        selection.typeCondition === undefined ||
        selection.typeCondition === effectiveType ||
        selection.typeCondition === parentType
      ) {
        Object.assign(result, executeSelections(selection.selections, parentType, parentValue, ctx));
      }
      continue;
    }
    const field = selection;
    const responseKey = field.alias ?? field.name;
    if (field.name === '__typename') {
      result[responseKey] = effectiveType;
      continue;
    }
    const knownFields = OBJECT_FIELDS[effectiveType] ?? [];
    if (!knownFields.includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${effectiveType}".` });
      result[responseKey] = null;
      continue;
    }
    const args = coerceArgs(field, ctx);
    let value: unknown;
    try {
      const resolver = RESOLVERS[`${effectiveType}.${field.name}`];
      value = resolver !== undefined ? resolver(parentValue, args, ctx) : parentValue[field.name];
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      result[responseKey] = null;
      continue;
    }
    if (value === null || value === undefined || field.selections === undefined) {
      result[responseKey] = value === undefined ? null : value;
      continue;
    }
    const fieldType = FIELD_TYPE[effectiveType]?.[field.name];
    if (fieldType === undefined) {
      result[responseKey] = value;
      continue;
    }
    if (Array.isArray(value)) {
      result[responseKey] = value.map((item) =>
        item !== null && typeof item === 'object'
          ? executeSelections(field.selections!, fieldType, item as GqlValue, ctx)
          : item,
      );
    } else if (typeof value === 'object') {
      result[responseKey] = executeSelections(field.selections, fieldType, value as GqlValue, ctx);
    } else {
      result[responseKey] = value;
    }
  }
  return result;
}

export interface GraphQLOperationInput {
  readonly query: string;
  readonly variables?: Record<string, unknown>;
  readonly operationName?: string;
}

export function executeGraphQL(store: Store, input: GraphQLOperationInput): Record<string, unknown> {
  let definitions: DefinitionNode[];
  try {
    definitions = parseGraphQL(input.query);
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const fragments = new Map<string, FragmentDefinition>();
  const operations: OperationDefinition[] = [];
  for (const definition of definitions) {
    if (definition.kind === 'fragment') fragments.set(definition.name, definition);
    else operations.push(definition);
  }
  let operation: OperationDefinition | undefined;
  if (input.operationName !== undefined) {
    operation = operations.find((candidate) => candidate.name === input.operationName);
  } else {
    operation = operations[0];
  }
  if (operation === undefined) {
    return { errors: [{ message: input.operationName !== undefined ? `Unknown operation named "${input.operationName}".` : 'No operation found.' }] };
  }
  const ctx: GqlContext = {
    store,
    variables: input.variables ?? {},
    variableDefs: operation.variables,
    fragments,
    errors: [],
  };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(operation.selections, rootType, {}, ctx);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope['errors'] = ctx.errors;
  return envelope;
}

// ---------------------------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------------------------

export function handleGraphQLRequest(store: Store, req: RequestInfo): HttpResult | null {
  if (req.segments.length !== 2 || req.segments[0] !== 'api' || req.segments[1] !== 'graphql') return null;
  if (req.method !== 'POST') throw new StoreError(404, 'Not Found');
  const parsed = parseJsonValue(req);
  if (Array.isArray(parsed)) {
    const results = parsed.map((item) => {
      if (item === null || typeof item !== 'object') return { errors: [{ message: 'Each batched operation must be an object.' }] };
      const record = item as Record<string, unknown>;
      const query = record['query'];
      if (typeof query !== 'string') return { errors: [{ message: 'Each batched operation must carry a query string.' }] };
      const variables = record['variables'];
      return executeGraphQL(store, {
        query,
        variables: variables !== null && typeof variables === 'object' && !Array.isArray(variables) ? (variables as Record<string, unknown>) : {},
        operationName: typeof record['operationName'] === 'string' ? record['operationName'] : undefined,
      });
    });
    return jsonResult(200, results);
  }
  if (parsed === null || typeof parsed !== 'object') {
    return jsonResult(200, { errors: [{ message: 'Request body must be a JSON object.' }] });
  }
  const record = parsed as Record<string, unknown>;
  const query = record['query'];
  if (typeof query !== 'string') {
    return jsonResult(200, { errors: [{ message: 'Request body must carry a query string.' }] });
  }
  const variables = record['variables'];
  return jsonResult(200, executeGraphQL(store, {
    query,
    variables: variables !== null && typeof variables === 'object' && !Array.isArray(variables) ? (variables as Record<string, unknown>) : {},
    operationName: typeof record['operationName'] === 'string' ? record['operationName'] : undefined,
  }));
}
