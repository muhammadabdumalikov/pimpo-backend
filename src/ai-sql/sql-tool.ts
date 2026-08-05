import {LlmToolDef} from '../ai/providers/llm-provider.interface';
import {SCHEMA_DOC_GENERATED} from './schema-doc.generated';
import {SCHEMA_DOC_NOTES} from './schema-doc.notes';

export const SQL_TOOL_NAME = 'run_sql';

export const SQL_TOOL: LlmToolDef = {
  name: SQL_TOOL_NAME,
  description:
    "Run one read-only SQL SELECT against this shop's database. Use ONLY when no other tool can answer the question — the tools above are faster and already encode the accounting rules. " +
    'Rows are automatically restricted to this shop, so never write a business_id condition. ' +
    'The query must be a single SELECT (a leading WITH is fine), with no semicolon and no comments. Always ORDER BY and LIMIT a ranking.',
  parameters: {
    type: 'object',
    properties: {
      sql: {
        type: 'string',
        description:
          'The SELECT statement. One statement only, no trailing semicolon.',
      },
      purpose: {
        type: 'string',
        description:
          'One short sentence on what this query answers, for the audit log.',
      },
    },
    required: ['sql'],
  },
};

/**
 * The full schema description appended to the system prompt when ad-hoc SQL is
 * enabled. Structural half generated from schema.ts, semantic half hand-written.
 */
export const SQL_SCHEMA_DOC = `# Database schema (for run_sql)
${SCHEMA_DOC_NOTES}

# Tables

${SCHEMA_DOC_GENERATED}`;
