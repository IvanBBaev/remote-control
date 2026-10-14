# Transcript fixtures

Main-session transcripts copied verbatim from the synthetic agenthropic fixture corpus
(`packages/test-fixtures`, v0.3.0): one `<fixture>.jsonl` per fixture that has a main
transcript. Every id, path, timestamp and line of prose is invented; nothing comes from a
real transcript. `transcript.test.ts` checks them against the fixture privacy pattern
(07 §5.4) and parses each one (04 W11, ADR 0014).
