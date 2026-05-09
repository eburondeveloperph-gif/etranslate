
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { useEffect, useRef } from 'react';
import WelcomeScreen from '../welcome-screen/WelcomeScreen';
// FIX: Import LiveServerContent to correctly type the content handler.
import { Modality, LiveServerContent } from '@google/genai';

import { useLiveAPIContext } from '../../../contexts/LiveAPIContext';
import {
  useSettings,
  useLogStore,
  ConversationTurn,
} from '../../../lib/state';
import { useHistoryStore } from '../../../lib/history';

export default function StreamingConsole() {
  const { client, setConfig, connected, connect, disconnect } = useLiveAPIContext();
  const { systemPrompt, voice, language1, language2 } = useSettings();
  const { addHistoryItem } = useHistoryStore();

  const turns = useLogStore(state => state.turns);
  const scrollRef = useRef<HTMLDivElement>(null);

  const isAutoDetect = language2 === 'Auto-Detect';
  const prevAutoDetect = useRef(isAutoDetect);

  useEffect(() => {
    if (prevAutoDetect.current && !isAutoDetect && connected) {
      // It transitioned from auto-detect to a specific language.
      // Disconnect and reconnect to apply the new system prompt in a fresh session.
      disconnect();
      setTimeout(() => {
        connect().catch(console.error);
      }, 1000); // Wait for disconnect to complete and state to settle
    }
    prevAutoDetect.current = isAutoDetect;
  }, [isAutoDetect, connected, disconnect, connect]);

  // Set the configuration for the Live API
  useEffect(() => {
    const isAutoDetect = language2 === 'Auto-Detect';
    
    // Using `any` for config to accommodate `speechConfig`, which is not in the
    // current TS definitions but is used in the working reference example.
    const config: any = {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voice,
          },
        },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      systemInstruction: {
        parts: [
          {
            text: isAutoDetect 
              ? `You are an expert language translator. The primary language is ${language1}.
For this first interaction, you MUST determine what the secondary language is based on the user's spoken input.
If the input is spoken in ${language1}, translate it to English and MUST immediately call the set_detected_language tool with "English".
If the input is spoken in another language, translate it to ${language1}, and you MUST immediately call the set_detected_language tool with that language.
DO NOT use conversational filler. RETURN ONLY THE TRANSLATED TEXT.`
              : systemPrompt,
          },
        ],
      },
      tools: isAutoDetect ? [
        {
          functionDeclarations: [
            {
              name: 'set_detected_language',
              description: 'Sets the detected foreign language if it is currently Auto-Detect',
              parameters: {
                type: 'OBJECT',
                properties: {
                  languageName: {
                    type: 'STRING',
                    description: 'The name of the detected language (e.g. Spanish, French)',
                  },
                },
                required: ['languageName'],
              },
            },
          ],
        },
      ] : [],
    };

    setConfig(config);
  }, [setConfig, systemPrompt, voice, language1, language2]);

  useEffect(() => {
    const { addTurn, updateLastTurn } = useLogStore.getState();

    const handleInputTranscription = (text: string, isFinal: boolean) => {
      const turns = useLogStore.getState().turns;
      const last = turns[turns.length - 1];
      if (last && last.role === 'user' && !last.isFinal) {
        updateLastTurn({
          text: last.text + text,
          isFinal,
        });
      } else {
        addTurn({ role: 'user', text, isFinal });
      }
    };

    const handleOutputTranscription = (text: string, isFinal: boolean) => {
      const turns = useLogStore.getState().turns;
      const last = turns[turns.length - 1];
      if (last && last.role === 'agent' && !last.isFinal) {
        updateLastTurn({
          text: last.text + text,
          isFinal,
        });
      } else {
        addTurn({ role: 'agent', text, isFinal });
      }
    };

    // FIX: The 'content' event provides a single LiveServerContent object.
    // The function signature is updated to accept one argument, and groundingMetadata is extracted from it.
    const handleContent = (serverContent: LiveServerContent) => {
      const text =
        serverContent.modelTurn?.parts
          ?.map((p: any) => p.text)
          .filter(Boolean)
          .join(' ') ?? '';
      const groundingChunks = serverContent.groundingMetadata?.groundingChunks;

      if (!text && !groundingChunks) return;

      const turns = useLogStore.getState().turns;
      // FIX: Replaced .at(-1) with standard index access to resolve potential compatibility issues.
      const last = turns[turns.length - 1];

      if (last?.role === 'agent' && !last.isFinal) {
        const updatedTurn: Partial<ConversationTurn> = {
          text: last.text + text,
        };
        if (groundingChunks) {
          updatedTurn.groundingChunks = [
            ...(last.groundingChunks || []),
            ...groundingChunks,
          ];
        }
        updateLastTurn(updatedTurn);
      } else {
        addTurn({ role: 'agent', text, isFinal: false, groundingChunks });
      }
    };

    const handleTurnComplete = () => {
      const { turns, updateLastTurn } = useLogStore.getState();
      // FIX: Replaced .at(-1) with standard index access to resolve potential compatibility issues.
      const last = turns[turns.length - 1];

      if (last && !last.isFinal) {
        updateLastTurn({ isFinal: true });
        const updatedTurns = useLogStore.getState().turns;

        // FIX: Replaced .at(-1) with standard index access to resolve potential compatibility issues.
        const finalAgentTurn = updatedTurns[updatedTurns.length - 1];

        if (finalAgentTurn?.role === 'agent' && finalAgentTurn?.text) {
          const agentTurnIndex = updatedTurns.length - 1;
          let correspondingUserTurn = null;
          for (let i = agentTurnIndex - 1; i >= 0; i--) {
            if (updatedTurns[i].role === 'user') {
              correspondingUserTurn = updatedTurns[i];
              break;
            }
          }

          if (correspondingUserTurn?.text) {
            const translatedText = finalAgentTurn.text.trim();
            addHistoryItem({
              sourceText: correspondingUserTurn.text.trim(),
              translatedText: translatedText,
              lang1: language1,
              lang2: language2
            });
          }
        }
      }
    };

    const handleToolCall = (toolCall: any) => {
      const calls = toolCall.functionCalls;
      if (calls && calls.length > 0) {
        for (const call of calls) {
          if (call.name === 'set_detected_language') {
            const langInfo = call.args;
            if (langInfo && (langInfo as any).languageName) {
              useSettings.getState().setLanguage2((langInfo as any).languageName);
              // Do we need to send response back? Yes, otherwise model gets stuck
              client.sendToolResponse({
                functionResponses: [
                  {
                    id: call.id,
                    name: call.name,
                    response: { success: true },
                  },
                ],
              } as any);
            }
          }
        }
      }
    };

    client.on('toolcall', handleToolCall);
    client.on('inputTranscription', handleInputTranscription);
    client.on('outputTranscription', handleOutputTranscription);
    client.on('content', handleContent);
    client.on('turncomplete', handleTurnComplete);

    return () => {
      client.off('toolcall', handleToolCall);
      client.off('inputTranscription', handleInputTranscription);
      client.off('outputTranscription', handleOutputTranscription);
      client.off('content', handleContent);
      client.off('turncomplete', handleTurnComplete);
    };
  }, [client, addHistoryItem, language1, language2]);

  return (
    <div className="transcription-container">
      <WelcomeScreen />
    </div>
  );
}
