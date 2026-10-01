import {
  BOARD_COLUMNS,
  BOARD_ROWS,
  type Coord,
  coordsEqual,
  formatCoord,
} from '../../shared/board.js';
import { cellColor } from '../../shared/color.js';
import type { GameSettings, HostCommand, HostGameState } from '../../shared/protocol.js';
import { CLUE_WORD_LIMITS, countWords, MAX_CLUE_LENGTH } from '../../shared/rules.js';
import { BoardView } from '../common/board-view.js';
import { type Child, formatSeconds, h, replaceChildren, requireElement } from '../common/dom.js';
import { type ConnectionStatus, GameSocket, ServerClock } from '../common/game-socket.js';
import { api, ApiError } from './api.js';
import { clearSession, type HostSession, loadSession, overlayUrl, saveSession } from './session.js';
import { toast } from './toast.js';

const app = requireElement('#app', HTMLElement);

void boot();

async function boot(): Promise<void> {
  const session = loadSession();
  if (session === null) {
    await renderSetup();
    return;
  }
  try {
    await api.getRoom(session.roomId);
    renderGame(session);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      clearSession();
      toast('Your previous room has expired. Create a new one.', 'error');
      await renderSetup();
    } else {
      // Server unreachable — the socket will keep retrying.
      renderGame(session);
    }
  }
}

// -----------------------------------------------------------------------------
// Setup
// -----------------------------------------------------------------------------

async function renderSetup(): Promise<void> {
  const { accessCodeRequired } = await api.getConfig().catch(() => ({ accessCodeRequired: false }));
  const channelInput = h('input', {
    attrs: {
      id: 'channel',
      name: 'channel',
      required: '',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: 'your_channel',
      pattern: '#?[A-Za-z0-9_]{3,25}',
    },
  });
  const codeInput = h('input', {
    attrs: { id: 'access-code', name: 'accessCode', type: 'password', autocomplete: 'off' },
  });
  const submit = h('button', {
    className: 'button button--primary',
    text: 'Create game room',
    attrs: { type: 'submit' },
  });
  const form = h(
    'form',
    { className: 'card setup' },
    h('h1', { text: 'Set up Hues & Cues' }),
    h('p', {
      className: 'muted',
      text: 'Enter the Twitch channel whose chat should play. No Twitch login is needed — the game only reads public chat.',
    }),
    h('label', { attrs: { for: 'channel' }, text: 'Twitch channel' }),
    channelInput,
    accessCodeRequired && h('label', { attrs: { for: 'access-code' }, text: 'Access code' }),
    accessCodeRequired && codeInput,
    submit,
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit.disabled = true;
    api
      .createRoom({
        channel: channelInput.value,
        ...(accessCodeRequired ? { accessCode: codeInput.value } : {}),
      })
      .then((room) => {
        const session: HostSession = {
          roomId: room.roomId,
          hostToken: room.hostToken,
          channel: room.channel,
        };
        saveSession(session);
        renderGame(session);
      })
      .catch((error: unknown) => {
        toast(error instanceof Error ? error.message : 'Could not create the room.', 'error');
        submit.disabled = false;
      });
  });
  replaceChildren(app, form);
  channelInput.focus();
}

// -----------------------------------------------------------------------------
// Game
// -----------------------------------------------------------------------------

function renderGame(session: HostSession): void {
  const clock = new ServerClock();
  let state: HostGameState | null = null;
  let phaseKey = '';
  let testerName = 'TestViewer';

  const send = (command: HostCommand): void => {
    socket.send(command);
  };

  const board = new BoardView({
    onCellClick: (coord) => {
      if (state?.phase === 'guessing') {
        send({ type: 'simulateGuess', displayName: testerName, coord });
      }
    },
  });

  // Header ------------------------------------------------------------------
  const connection = h('span', { className: 'pill' });
  const chatStatus = h('span', { className: 'pill' });
  const overlayInput = h('input', {
    className: 'mono',
    attrs: { readonly: '', value: overlayUrl(session), 'aria-label': 'Overlay URL' },
  });
  const header = h(
    'header',
    { className: 'topbar' },
    h(
      'div',
      { className: 'topbar__brand' },
      h('strong', { text: 'Hues & Cues' }),
      h('span', { className: 'muted', text: `#${session.channel}` }),
    ),
    h('div', { className: 'topbar__status' }, connection, chatStatus),
  );

  const overlayCard = h(
    'section',
    { className: 'card' },
    h('h2', { text: 'OBS browser source' }),
    h('p', {
      className: 'muted',
      text: 'Add a Browser Source in OBS with this URL, sized 1920 × 1080.',
    }),
    overlayInput,
    h(
      'div',
      { className: 'actions' },
      h('button', {
        className: 'button',
        text: 'Copy',
        attrs: { type: 'button' },
        on: {
          click: () => {
            void navigator.clipboard.writeText(overlayInput.value).then(
              () => {
                toast('Overlay URL copied.');
              },
              () => {
                overlayInput.select();
              },
            );
          },
        },
      }),
      h('a', {
        className: 'button',
        text: 'Preview',
        attrs: { href: `${overlayUrl(session)}&bg=solid`, target: '_blank', rel: 'noopener' },
      }),
    ),
    h('p', {
      className: 'hint',
      text: 'Viewers of this link can watch but not control the game. Control access is saved in this browser only.',
    }),
  );

  // Round panel --------------------------------------------------------------
  const roundPanel = h('section', { className: 'card round' });
  const liveInfo = h('div', { className: 'live-info' });

  // Scores -------------------------------------------------------------------
  const leaderboard = h('ol', { className: 'leaderboard' });
  const hostScore = h('span', { className: 'muted' });
  const scoresCard = h(
    'section',
    { className: 'card' },
    h('div', { className: 'card__header' }, h('h2', { text: 'Leaderboard' }), hostScore),
    leaderboard,
    h('button', {
      className: 'button button--danger button--small',
      text: 'Reset scores',
      attrs: { type: 'button' },
      on: {
        click: () => {
          if (window.confirm('Reset every player’s score to zero?')) send({ type: 'resetScores' });
        },
      },
    }),
  );

  // Settings -----------------------------------------------------------------
  const settingsForm = buildSettings((patch) => {
    send({ type: 'updateSettings', settings: patch });
  });

  // Test tools ---------------------------------------------------------------
  const testerInput = h('input', {
    attrs: { value: testerName, maxlength: '25', 'aria-label': 'Test player name' },
  });
  testerInput.addEventListener('input', () => {
    testerName = testerInput.value.trim() || 'TestViewer';
  });
  const testCard = h(
    'section',
    { className: 'card' },
    h('h2', { text: 'Test without chat' }),
    h('p', {
      className: 'muted',
      text: 'While guessing is open, click any square on the board to add a guess as this player.',
    }),
    testerInput,
    h('button', {
      className: 'button button--small',
      text: 'Add 10 random guesses',
      attrs: { type: 'button' },
      on: {
        click: () => {
          if (state?.phase !== 'guessing') {
            toast('Open guessing first by giving a clue.', 'error');
            return;
          }
          for (let i = 1; i <= 10; i += 1) {
            send({
              type: 'simulateGuess',
              displayName: `Bot${String(i)}`,
              coord: {
                row: Math.floor(Math.random() * BOARD_ROWS),
                col: Math.floor(Math.random() * BOARD_COLUMNS),
              },
            });
          }
        },
      },
    }),
  );

  const forget = h('button', {
    className: 'button button--ghost button--small',
    text: 'Switch channel / forget this room',
    attrs: { type: 'button' },
    on: {
      click: () => {
        if (
          !window.confirm(
            'Forget this room on this browser? Your overlay URL will stop working for you to control.',
          )
        )
          return;
        socket.close();
        clearSession();
        void renderSetup();
      },
    },
  });

  replaceChildren(
    app,
    header,
    h(
      'div',
      { className: 'layout' },
      h(
        'div',
        { className: 'layout__main' },
        roundPanel,
        h('section', { className: 'card board-card' }, liveInfo, board.element),
      ),
      h(
        'div',
        { className: 'layout__side' },
        overlayCard,
        scoresCard,
        settingsForm.element,
        testCard,
        forget,
      ),
    ),
  );

  // Rendering ------------------------------------------------------------------
  const renderLiveInfo = (): void => {
    if (!state) return;
    const parts: string[] = [`Round ${String(state.roundNumber)}`, phaseLabel(state.phase)];
    if (state.phase === 'guessing') {
      parts.push(`${String(state.totalGuesses)} guesses`);
      if (state.deadline !== null)
        parts.push(`${formatSeconds(clock.secondsUntil(state.deadline))}s left`);
    }
    liveInfo.textContent = parts.join(' · ');
  };

  const render = (next: HostGameState): void => {
    state = next;
    const key = [
      next.phase,
      next.roundNumber,
      next.clues.length,
      next.card?.map(formatCoord).join(',') ?? '',
      next.target ? formatCoord(next.target) : '',
    ].join('|');
    if (key !== phaseKey) {
      phaseKey = key;
      replaceChildren(roundPanel, ...roundPanelContent(next, send));
    }
    board.render({
      cellCounts: next.cellCounts,
      card: next.phase === 'picking' ? next.card : null,
      target: next.target,
      showFrames: next.phase === 'reveal',
    });
    board.element.classList.toggle('board--clickable', next.phase === 'guessing');
    settingsForm.update(next.settings);
    hostScore.textContent = `Your score: ${String(next.hostScore)}`;
    replaceChildren(
      leaderboard,
      ...(next.leaderboard.length === 0
        ? [h('li', { className: 'empty muted', text: 'No scores yet.' })]
        : next.leaderboard
            .slice(0, 15)
            .map((player) =>
              h(
                'li',
                {},
                h('span', { text: player.displayName }),
                h('span', { className: 'score', text: String(player.score) }),
              ),
            )),
    );
    renderLiveInfo();
  };

  const setConnection = (status: ConnectionStatus, detail?: string): void => {
    connection.textContent =
      status === 'open' ? 'Server connected' : status === 'failed' ? 'Disconnected' : 'Connecting…';
    connection.dataset.state = status === 'open' ? 'ok' : status === 'failed' ? 'bad' : 'warn';
    if (status === 'failed') {
      toast(detail ?? 'Disconnected from the server.', 'error');
    }
  };

  const socket = new GameSocket<HostGameState>(
    { type: 'hello', role: 'host', roomId: session.roomId, token: session.hostToken },
    {
      onState: (next, serverTime) => {
        clock.sync(serverTime);
        render(next);
      },
      onStatus: setConnection,
      onChatStatus: (connected) => {
        chatStatus.textContent = connected ? 'Twitch chat connected' : 'Twitch chat reconnecting…';
        chatStatus.dataset.state = connected ? 'ok' : 'warn';
      },
      onError: (message) => {
        toast(message, 'error');
      },
    },
  );
  socket.connect();
  window.setInterval(renderLiveInfo, 500);
}

function phaseLabel(phase: HostGameState['phase']): string {
  switch (phase) {
    case 'idle':
      return 'Ready';
    case 'picking':
      return 'Choosing a colour';
    case 'guessing':
      return 'Chat is guessing';
    case 'intermission':
      return 'Between clues';
    case 'reveal':
      return 'Revealed';
  }
}

function roundPanelContent(state: HostGameState, send: (command: HostCommand) => void): Child[] {
  const button = (
    text: string,
    command: HostCommand,
    variant: 'primary' | 'default' | 'danger' | 'ghost' = 'default',
  ): HTMLButtonElement =>
    h('button', {
      className: `button${variant === 'default' ? '' : ` button--${variant}`}`,
      text,
      attrs: { type: 'button' },
      on: {
        click: () => {
          send(command);
        },
      },
    });
  const cancel = button('Cancel round', { type: 'cancelRound' }, 'ghost');

  switch (state.phase) {
    case 'idle':
      return [
        h('h2', { text: 'Start a round' }),
        h('p', {
          className: 'muted',
          text: 'Draw a card, choose one of its four colours in secret, then give chat a one-word clue.',
        }),
        h('div', { className: 'actions' }, button('Draw a card', { type: 'drawCard' }, 'primary')),
      ];

    case 'picking': {
      const card = state.card ?? [];
      const swatches = h(
        'div',
        { className: 'swatches', attrs: { role: 'radiogroup', 'aria-label': 'Card colours' } },
        ...card.map((coord, index) => {
          const selected = state.target !== null && coordsEqual(coord, state.target);
          return h(
            'button',
            {
              className: `swatch-option${selected ? ' swatch-option--selected' : ''}`,
              attrs: { type: 'button', role: 'radio', 'aria-checked': String(selected) },
              on: {
                click: () => {
                  send({ type: 'selectTarget', index });
                },
              },
            },
            h('span', {
              className: 'swatch-option__colour',
              style: { background: cellColor(coord) },
            }),
            h('span', {
              className: 'swatch-option__label',
              text: `${String(index + 1)} · ${formatCoord(coord)}`,
            }),
          );
        }),
      );
      return [
        h(
          'div',
          { className: 'card__header' },
          h('h2', { text: `Round ${String(state.roundNumber)} — choose your colour` }),
          button('Redraw card', { type: 'drawCard' }, 'ghost'),
        ),
        h('p', {
          className: 'muted',
          text: 'Only you can see this card. Pick one colour, then describe it in one word.',
        }),
        swatches,
        state.target
          ? clueForm(state, 1, 'Start guessing', send)
          : h('p', { className: 'hint', text: 'Select a colour above to continue.' }),
        h('div', { className: 'actions' }, cancel),
      ];
    }

    case 'guessing':
      return [
        h('h2', { text: `Clue ${String(state.activeClue ?? 1)}: “${state.clues.at(-1) ?? ''}”` }),
        targetPreview(state.target),
        h(
          'div',
          { className: 'actions' },
          button(
            state.activeClue === 1 && state.settings.useSecondClue
              ? 'Close guessing'
              : 'Close guessing & reveal',
            { type: 'closeGuessing' },
            'primary',
          ),
          state.activeClue === 1 &&
            state.settings.useSecondClue &&
            button('Reveal now (skip clue 2)', { type: 'reveal' }),
          cancel,
        ),
      ];

    case 'intermission':
      return [
        h('h2', { text: 'Give a second clue' }),
        targetPreview(state.target),
        h('p', {
          className: 'muted',
          text: 'Chatters get a second guess. Your second clue may be up to two words.',
        }),
        clueForm(state, 2, 'Open second guess', send),
        h('div', { className: 'actions' }, button('Reveal now', { type: 'reveal' }), cancel),
      ];

    case 'reveal': {
      const result = state.lastResult;
      return [
        h('h2', { text: `Round ${String(state.roundNumber)} results` }),
        result
          ? h(
              'p',
              {},
              `The colour was ${formatCoord(result.target)}. ${String(result.totalGuessers)} players guessed; `,
              `${String(result.awards.length)} scored. You earned ${String(result.hostPoints)}.`,
            )
          : null,
        h(
          'div',
          { className: 'actions' },
          button('Next round', { type: 'drawCard' }, 'primary'),
          button('Back to lobby', { type: 'cancelRound' }, 'ghost'),
        ),
      ];
    }
  }
}

function targetPreview(target: Coord | null): Node {
  return target
    ? h(
        'div',
        { className: 'target-preview' },
        h('span', { className: 'swatch', style: { background: cellColor(target) } }),
        h('span', { text: `Your colour: ${formatCoord(target)} (hidden from chat)` }),
      )
    : h('span');
}

function clueForm(
  state: HostGameState,
  clueNumber: 1 | 2,
  submitLabel: string,
  send: (command: HostCommand) => void,
): HTMLFormElement {
  const limit = CLUE_WORD_LIMITS[clueNumber];
  const input = h('input', {
    attrs: {
      id: `clue-${String(clueNumber)}`,
      required: '',
      maxlength: String(MAX_CLUE_LENGTH),
      autocomplete: 'off',
      placeholder: clueNumber === 1 ? 'e.g. ocean' : 'e.g. deep ocean',
    },
  });
  const counter = h('span', { className: 'hint' });
  const submit = h('button', {
    className: 'button button--primary',
    text: submitLabel,
    attrs: { type: 'submit' },
  });
  const validate = (): void => {
    const words = countWords(input.value);
    const tooMany = state.settings.enforceClueWordLimits && words > limit;
    counter.textContent = `${String(words)} / ${String(limit)} word${limit === 1 ? '' : 's'}`;
    counter.classList.toggle('hint--error', tooMany);
    submit.disabled = words === 0 || tooMany;
  };
  input.addEventListener('input', validate);
  validate();

  const form = h(
    'form',
    { className: 'clue-form' },
    h('label', {
      attrs: { for: input.id },
      text: clueNumber === 1 ? 'Your clue' : 'Your second clue',
    }),
    h('div', { className: 'clue-form__row' }, input, submit),
    counter,
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    send({ type: 'giveClue', clue: input.value });
  });
  window.setTimeout(() => {
    input.focus();
  }, 0);
  return form;
}

interface SettingsForm {
  readonly element: HTMLElement;
  update(settings: GameSettings): void;
}

function buildSettings(onChange: (patch: Partial<GameSettings>) => void): SettingsForm {
  const duration = h('input', {
    attrs: {
      id: 'duration',
      type: 'number',
      min: '0',
      max: '600',
      step: '5',
      inputmode: 'numeric',
    },
  });
  duration.addEventListener('change', () => {
    const value = Math.round(Number(duration.value));
    if (Number.isFinite(value) && value >= 0 && value <= 600)
      onChange({ guessDurationSeconds: value });
  });

  const toggles: { key: Exclude<keyof GameSettings, 'guessDurationSeconds'>; label: string }[] = [
    { key: 'useSecondClue', label: 'Use a second (two-word) clue each round' },
    { key: 'allowGuessChanges', label: 'Let chatters change their guess' },
    { key: 'requireGuessCommand', label: 'Require !guess (ignore bare “F12”)' },
    { key: 'enforceClueWordLimits', label: 'Enforce clue word limits' },
  ];
  const checkboxes = toggles.map(({ key, label }) => {
    const input = h('input', { attrs: { type: 'checkbox', id: `setting-${key}` } });
    input.addEventListener('change', () => {
      onChange({ [key]: input.checked });
    });
    return {
      key,
      input,
      row: h('label', { className: 'checkbox' }, input, h('span', { text: label })),
    };
  });

  const element = h(
    'section',
    { className: 'card' },
    h('h2', { text: 'Settings' }),
    h('label', { attrs: { for: 'duration' }, text: 'Guess timer (seconds, 0 = close manually)' }),
    duration,
    ...checkboxes.map(({ row }) => row),
  );

  return {
    element,
    update(settings) {
      if (document.activeElement !== duration)
        duration.value = String(settings.guessDurationSeconds);
      for (const { key, input } of checkboxes) input.checked = settings[key];
    },
  };
}
