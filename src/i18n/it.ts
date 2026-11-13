import type { Catalog } from "./en.ts";

export const it = {
  // Intestazioni ed etichette
  permission: "🔐 Richiesta di permesso",
  question: "❓ Domanda",
  completed: "✅ Task completato",
  failed: "❌ Task fallito",
  cancelled: "⏹ Task annullato",
  project: "Progetto",
  session: "Sessione",
  eventsLabel: "Eventi",
  empty: "(nessun dettaglio)",

  // Bottoni ed esiti dei permessi
  answerOnce: "Consenti una volta",
  answerAlways: "Consenti sempre",
  answerReject: "Rifiuta",
  doneAllowed: "✅ Consentito ({decision})",
  doneRejected: "🚫 Rifiutato",
  doneCancelled: "⏹ Annullato",
  decisionOnce: "una volta",
  decisionAlways: "sempre",
  decisionReject: "rifiutato",

  // Bottoni ed esiti delle domande
  doneAnswered: "✅ Risposto da Telegram",
  doneSkipped: "⏹ Saltato da Telegram",
  questionSkip: "⏹ Salta",
  answeredInTerminal: "Già risposto (terminale)",
  expiredOrStale: "Scaduto o già risposto altrove",

  // Fallback nel terminale
  answerInTerminal: "⌨️ Rispondi nel terminale — questo tipo di domanda non ha bottoni.",
  permissionAnswerInTerminal:
    "⌨️ Rispondi nel terminale — la risposta con tap non è disponibile per questa notifica.",
  replyFailedRetry: "Invio non riuscito — tocca di nuovo o rispondi nel terminale.",
  answerWithButtons:
    "👆 Rispondi qui sotto — un tap lo invia all'agente. Niente viene mai inviato da solo.",

  // Comandi del bot
  start: [
    "🤖 <b>opencode-telegram-notify</b> è online.",
    "Chat ID: <code>{chatId}</code>",
    "Riceverai notifiche per permessi, domande e ciclo di vita dei task.",
    "I bottoni dei permessi sono tap-only: nessuna approvazione automatica.",
  ].join("\n"),
  help: [
    "Comandi:",
    "/start — info di connessione + chat id",
    "/status — stato del plugin",
    "/setup — config pronta da copiare",
    "/stop — silenzia questa chat",
    "Comandi sconosciuti e messaggi normali vengono ignorati.",
  ].join("\n"),
  shuttingDone: "🔕 Chat silenziata. Premi /start per riattivare.",
  statusOnline: "🟢 Plugin attivo",
  statusInteractive: "🖲 Bottoni: attivi",
  statusStandby: "💤 Bottoni: standby (un'altra istanza sta facendo polling)",
  statusActive: "🔔 Notifiche attive",
  statusSilenced: "🔕 Silenziato (usa /start)",
  commandStart: "Connetti + chat id",
  commandStatus: "Stato del plugin",
  commandSetup: "Config da copiare",
  commandStop: "Silenzia fino a /start",
  commandHelp: "Cosa fa questo bot",
  envVars: "Variabili d'ambiente:",

  // Etichette di utilizzo e errore
  usageLabel: "⚡",
  usageIn: "in",
  usageOut: "out",
  limitFree: "⛔ Limite utilizzo gratuito raggiunto",
  limitQuota: "⛔ Quota provider raggiunta",
  limitRate: "⛔ Rate limit raggiunto",
  limitBudget: "⛔ Budget del workspace raggiunto",
  limitModelBudget: "⛔ Budget del modello raggiunto",
} satisfies Catalog;
