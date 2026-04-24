import { OutlookSearchAssistantSystemPrompt } from '../../../lib/prompts';
import { activeDriverProcedure } from '../../trpc';
import { openai } from '@ai-sdk/openai';
import { generateObject } from 'ai';
import { env } from '../../../env';
import { z } from 'zod';

export const generateSearchQuery = activeDriverProcedure
  .input(z.object({ query: z.string() }))
  .mutation(async ({ input }) => {
    // Google path retired in Phase 2e. Microsoft is the only supported
    // provider today.
    const systemPrompt = OutlookSearchAssistantSystemPrompt();

    const result = await generateObject({
      model: openai(env.OPENAI_MODEL || 'gpt-4o'),
      system: systemPrompt,
      prompt: input.query,
      schema: z.object({
        query: z.string(),
      }),
      output: 'object',
    });

    return result.object;
  });
