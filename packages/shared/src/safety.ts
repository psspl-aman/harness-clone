import { z } from 'zod';

export type SafetyDecision = 'pending' | 'approved' | 'denied' | 'expired' | 'blocked';

/** A tool call an agent wants to make that needs (or needed) your decision. */
export interface SafetyApprovalDto {
  id: string;
  projectId: string | null;
  projectName: string | null;
  taskId: string | null;
  taskKey: string | null;
  role: string | null;
  engineId: string;
  tool: string;
  summary: string;
  reason: string;
  status: SafetyDecision;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
}

export const DecideApprovalSchema = z.object({ decision: z.enum(['approve', 'deny']) });
