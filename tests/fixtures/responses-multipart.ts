// Small synthetic continuation matching pinned OpenCode v2.0.32 after a
// nonzero-exit shell command. Tool streams are synthetic; no repository data.
export const responsesMultipartToolOutputFixture = [
  { role: 'user', content: 'Review this change' },
  {
    type: 'message',
    role: 'assistant',
    id: 'msg_commentary_1',
    status: 'completed',
    phase: 'commentary',
    content: [{ type: 'output_text', text: 'I will run the failing shell command.' }],
  },
  {
    type: 'reasoning',
    id: 'rs_1',
    encrypted_content: 'encrypted-reasoning',
    summary: [],
  },
  {
    type: 'function_call',
    id: 'fc_shell',
    call_id: 'call_shell',
    name: 'shell',
    arguments: '{"command":"echo stdout-line; echo stderr-line >&2; exit 7"}',
  },
  {
    type: 'function_call_output',
    call_id: 'call_shell',
    output: [
      { type: 'input_text', text: 'stdout-line\n' },
      { type: 'input_text', text: 'stderr-line\n' },
      { type: 'input_text', text: 'Exited with code 7' },
    ],
  },
  {
    type: 'message',
    role: 'assistant',
    id: 'msg_final_1',
    status: 'completed',
    phase: 'final_answer',
    content: [{ type: 'output_text', text: 'The command failed.' }],
  },
] as const;
