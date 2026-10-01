/**
 * Wire protocol between the server and browser clients.
 *
 * Client → server messages are validated with zod on the server. The
 * browser bundle must only `import type` from this module (runtime constants
 * live in `endpoints.ts`), so zod is never shipped to the overlay.
 */
import { z } from 'zod';
import { BOARD_COLUMNS, BOARD_ROWS, type Coord } from './board.js';
import { CARD_SIZE, MAX_CLUE_LENGTH } from './rules.js';

export { WS_PATH } from './endpoints.js';

export type Phase = 'idle' | 'picking' | 'guessing' | 'intermission' | 'reveal';
export type ClientRole = 'host' | 'overlay';
export type ClueNumber = 1 | 2;

export const MAX_GUESS_DURATION_SECONDS = 600;

export const gameSettingsSchema = z.object({
  /** Seconds guessing stays open after a clue; 0 means the host closes it manually. */
  guessDurationSeconds: z.number().int().min(0).max(MAX_GUESS_DURATION_SECONDS),
  /** Whether chatters may move their guess while guessing is open. */
  allowGuessChanges: z.boolean(),
  /** Whether rounds include the optional second (two-word) clue. */
  useSecondClue: z.boolean(),
  /** Require `!guess F12` rather than accepting a bare `F12` in chat. */
  requireGuessCommand: z.boolean(),
  /** Enforce the one-word / two-word clue limits. */
  enforceClueWordLimits: z.boolean(),
});
export type GameSettings = z.infer<typeof gameSettingsSchema>;

export const DEFAULT_SETTINGS: GameSettings = {
  guessDurationSeconds: 45,
  allowGuessChanges: true,
  useSecondClue: true,
  requireGuessCommand: false,
  enforceClueWordLimits: true,
};

export const coordSchema = z.object({
  row: z
    .number()
    .int()
    .min(0)
    .max(BOARD_ROWS - 1),
  col: z
    .number()
    .int()
    .min(0)
    .max(BOARD_COLUMNS - 1),
});

const roomIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/u);

export const helloMessageSchema = z.discriminatedUnion('role', [
  z.object({ type: z.literal('hello'), role: z.literal('overlay'), roomId: roomIdSchema }),
  z.object({
    type: z.literal('hello'),
    role: z.literal('host'),
    roomId: roomIdSchema,
    token: z.string().min(16).max(256),
  }),
]);
export type HelloMessage = z.infer<typeof helloMessageSchema>;

export const hostCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('drawCard') }),
  z.object({
    type: z.literal('selectTarget'),
    index: z
      .number()
      .int()
      .min(0)
      .max(CARD_SIZE - 1),
  }),
  z.object({ type: z.literal('giveClue'), clue: z.string().trim().min(1).max(MAX_CLUE_LENGTH) }),
  z.object({ type: z.literal('closeGuessing') }),
  z.object({ type: z.literal('reveal') }),
  z.object({ type: z.literal('cancelRound') }),
  z.object({ type: z.literal('resetScores') }),
  z.object({ type: z.literal('updateSettings'), settings: gameSettingsSchema.partial() }),
  z.object({
    type: z.literal('simulateGuess'),
    displayName: z.string().trim().min(1).max(25),
    coord: coordSchema,
  }),
]);
export type HostCommand = z.infer<typeof hostCommandSchema>;
export type HostCommandType = HostCommand['type'];

export interface PublicGuess {
  readonly userId: string;
  readonly displayName: string;
  readonly color: string | null;
  readonly coord: Coord;
  readonly clueNumber: ClueNumber;
  readonly at: number;
}

export interface PlayerScore {
  readonly userId: string;
  readonly displayName: string;
  readonly color: string | null;
  readonly score: number;
}

export interface RoundAward {
  readonly userId: string;
  readonly displayName: string;
  readonly color: string | null;
  readonly points: number;
  /** The player's guess that scored best this round. */
  readonly bestGuess: Coord;
}

export interface RoundResult {
  readonly roundNumber: number;
  readonly target: Coord;
  readonly clues: readonly string[];
  readonly awards: readonly RoundAward[];
  readonly hostPoints: number;
  readonly totalGuessers: number;
}

/** What everyone (including the stream overlay) is allowed to see. */
export interface PublicGameState {
  readonly channel: string;
  readonly phase: Phase;
  readonly roundNumber: number;
  readonly clues: readonly string[];
  readonly activeClue: ClueNumber | null;
  /** Epoch milliseconds at which guessing closes, if timed. */
  readonly deadline: number | null;
  /** The most recent guesses this round (capped; see `totalGuesses`). */
  readonly guesses: readonly PublicGuess[];
  /** Number of guesses on each occupied cell this round, as `[coordKey, count]` pairs. */
  readonly cellCounts: readonly (readonly [number, number])[];
  readonly totalGuesses: number;
  readonly leaderboard: readonly PlayerScore[];
  readonly hostScore: number;
  readonly lastResult: RoundResult | null;
  readonly settings: GameSettings;
}

/** The host additionally sees the secret card and chosen target. */
export interface HostGameState extends PublicGameState {
  readonly card: readonly Coord[] | null;
  readonly target: Coord | null;
}

export type ErrorCode =
  'bad_request' | 'unauthorized' | 'not_found' | 'invalid_state' | 'rate_limited' | 'internal';

export type ServerMessage =
  | { readonly type: 'welcome'; readonly role: ClientRole; readonly serverTime: number }
  | {
      readonly type: 'state';
      readonly role: 'overlay';
      readonly state: PublicGameState;
      readonly serverTime: number;
    }
  | {
      readonly type: 'state';
      readonly role: 'host';
      readonly state: HostGameState;
      readonly serverTime: number;
    }
  | { readonly type: 'chatStatus'; readonly connected: boolean }
  | { readonly type: 'error'; readonly code: ErrorCode; readonly message: string };

/** REST: request body for `POST /api/rooms`. */
export const createRoomRequestSchema = z.object({
  channel: z
    .string()
    .trim()
    .transform((value) => value.replace(/^#/u, '').toLowerCase())
    .pipe(z.string().regex(/^[a-z0-9_]{3,25}$/u, 'Not a valid Twitch channel name')),
  accessCode: z.string().max(256).optional(),
});
export type CreateRoomRequest = z.input<typeof createRoomRequestSchema>;

export interface CreateRoomResponse {
  readonly roomId: string;
  readonly hostToken: string;
  readonly channel: string;
}

export interface RoomInfoResponse {
  readonly roomId: string;
  readonly channel: string;
}

export interface ApiErrorResponse {
  readonly error: string;
  readonly code: ErrorCode;
}
