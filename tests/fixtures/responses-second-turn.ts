// Sanitized second-round request captured from pinned OpenCode v2.0.32
// against a loopback Responses fixture. Tool output, instructions,
// prompt-cache key and model route were replaced; the read tool and replay items are retained.
export const responsesSecondTurnFixture = {
  model: 'sol-review',
  input: [
    {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: '"Read README.md with the read tool, then reply done."' },
      ],
    },
    {
      type: 'reasoning',
      id: 'rs_probe_1',
      summary: [],
      encrypted_content: 'opaque-probe-reasoning',
    },
    {
      type: 'function_call',
      id: 'fc_probe_1',
      call_id: 'call_probe_1',
      name: 'read',
      arguments: '{"path":"README.md"}',
    },
    { type: 'function_call_output', call_id: 'call_probe_1', output: '[tool output omitted]' },
  ],
  instructions: '[sanitized review instructions]',
  stream: true,
  max_output_tokens: 32000,
  store: false,
  prompt_cache_key: 'fixture-session',
  include: ['reasoning.encrypted_content'],
  tools: [
    {
      type: 'function',
      name: 'read',
      description:
        'Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or directory to read' },
          offset: {
            type: 'integer',
            minimum: 0,
            description: 'The line or directory entry to start reading from (1-based)',
          },
          limit: {
            type: 'integer',
            minimum: 0,
            description:
              'The maximum number of lines or directory entries to read (defaults to and capped at 2000)',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      strict: false,
    },
  ],
} as const;
