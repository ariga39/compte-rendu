import { Schema } from 'effect';

const RequestRecord = Schema.Record(Schema.String, Schema.Unknown);
export const COMMON_FORBIDDEN_KEYS = [
  'previous_response_id',
  'conversation',
  'background',
  'container',
  'mcp_servers',
  'cachedContent',
] as const;
const REMOTE_PART_KEYS = [
  'image_url',
  'file',
  'input_audio',
  'audio',
  'url',
  'file_id',
  'file_url',
  'source',
] as const;

export const isRecord = Schema.is(RequestRecord);
export const isNonEmptyString = Schema.is(Schema.NonEmptyString);

export const hasAnyKey = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  keys.some((key) => Object.hasOwn(value, key));

const CHAT_CONTENT_FIELDS = { text: 'text', refusal: 'refusal' } as const;
const RESPONSES_CONTENT_FIELDS = {
  input_text: 'text',
  output_text: 'text',
  refusal: 'refusal',
} as const;
const INPUT_TEXT_FIELDS = { input_text: 'text' } as const;

const isLocalContentPart = (part: unknown, fields: Readonly<Record<string, string>>): boolean => {
  if (!isRecord(part) || hasAnyKey(part, REMOTE_PART_KEYS)) return false;
  if (typeof part.type !== 'string' || !Object.hasOwn(fields, part.type)) return false;
  return typeof part[fields[part.type]] === 'string';
};

// Chat assistant content parts carry text in `text` and refusals in `refusal`.
export const isLocalChatContentPart = (part: unknown): boolean =>
  isLocalContentPart(part, CHAT_CONTENT_FIELDS);
export const isLocalResponsesContentPart = (part: unknown): boolean =>
  isLocalContentPart(part, RESPONSES_CONTENT_FIELDS);
export const isLocalInputTextPart = (part: unknown): boolean =>
  isLocalContentPart(part, INPUT_TEXT_FIELDS);

export const isFunctionRef = (value: unknown): boolean =>
  isRecord(value) && isNonEmptyString(value.name);

export const isFunctionTool = (value: unknown, nested: boolean): boolean =>
  isRecord(value) && value.type === 'function' && isFunctionRef(nested ? value.function : value);

export const isLocalToolChoice = (choice: unknown, nested: boolean): boolean => {
  if (choice === undefined) return true;
  if (typeof choice === 'string') return ['none', 'auto', 'required'].includes(choice);
  return isFunctionTool(choice, nested);
};
