import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGroupActivity,
  groupAutonomyConfig,
  noteGroupBotMessage,
  noteGroupMessage,
  shouldAutoParticipate,
  shouldSendIdleMessage,
} from '../src/group-autonomy.mjs';

test('GROUP_AUTO_PARTICIPATE 关闭时不自动参与', () => {
  const config = groupAutonomyConfig({ GROUP_AUTO_PARTICIPATE: 'off' });
  const decision = shouldAutoParticipate({
    text: '大家怎么看这个方案？',
    config,
    activity: createGroupActivity(),
    now: 10_000,
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'auto_participate_off');
});

test('自动参与开启时按触发词、冷却和每小时上限判断', () => {
  const config = groupAutonomyConfig({
    GROUP_AUTO_PARTICIPATE: 'on',
    GROUP_AUTO_MODE: 'conservative',
    GROUP_AUTO_COOLDOWN_MS: '60000',
    GROUP_AUTO_MAX_PER_HOUR: '2',
  });
  assert.equal(shouldAutoParticipate({
    text: '大家怎么看这个风险？',
    config,
    activity: createGroupActivity(),
    now: 100_000,
  }).ok, true);
  assert.equal(shouldAutoParticipate({
    text: '普通陈述没有触发点',
    config,
    activity: createGroupActivity(),
    now: 100_000,
  }).reason, 'no_trigger');
  assert.equal(shouldAutoParticipate({
    text: '大家怎么看？',
    config,
    activity: noteGroupBotMessage(createGroupActivity(), 90_000),
    now: 100_000,
  }).reason, 'cooldown');
  assert.equal(shouldAutoParticipate({
    text: '大家怎么看？',
    config,
    activity: { ...createGroupActivity(), lastBotAt: 1_000, recentBotReplies: [1_000, 2_000] },
    now: 100_000,
  }).reason, 'hourly_limit');
});

test('normal 模式下可因话题信号或连续聊天自动参与', () => {
  const config = groupAutonomyConfig({
    GROUP_AUTO_PARTICIPATE: 'on',
    GROUP_AUTO_MODE: 'normal',
    GROUP_AUTO_COOLDOWN_MS: '10000',
    GROUP_AUTO_MIN_MESSAGES_SINCE_BOT: '3',
  });
  assert.equal(shouldAutoParticipate({
    text: '最近这个项目有点卡住',
    config,
    activity: createGroupActivity(),
    now: 100_000,
  }).reason, 'topic_signal');
  assert.equal(shouldAutoParticipate({
    text: '普通聊天继续往下说',
    config,
    activity: { ...createGroupActivity(), messagesSinceBot: 3 },
    now: 100_000,
  }).reason, 'conversation_burst');
});

test('chatty 模式默认更短冷却并允许更频繁参与', () => {
  const config = groupAutonomyConfig({
    GROUP_AUTO_PARTICIPATE: 'on',
    GROUP_AUTO_MODE: 'chatty',
  });
  assert.equal(config.cooldownMs, 45_000);
  assert.equal(config.minMessagesSinceBot, 1);
  assert.equal(config.maxPerHour, 30);
});

test('空闲主动消息按 idle 开关和活跃时间判断', () => {
  const config = groupAutonomyConfig({
    GROUP_IDLE_AUTO_MESSAGE: 'on',
    GROUP_IDLE_MS: '60000',
    GROUP_AUTO_MAX_PER_HOUR: '3',
  });
  const active = noteGroupMessage(createGroupActivity(), 10_000);
  assert.equal(shouldSendIdleMessage({ activity: active, config, now: 50_000 }).reason, 'not_idle');
  assert.equal(shouldSendIdleMessage({ activity: active, config, now: 80_000 }).ok, true);
  const botRecent = noteGroupBotMessage(active, 75_000);
  assert.equal(shouldSendIdleMessage({ activity: botRecent, config, now: 80_000 }).reason, 'bot_recent');
});
