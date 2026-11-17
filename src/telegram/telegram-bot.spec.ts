import {commandOf, isPlatformChat} from './telegram-bot.service';

describe('isPlatformChat', () => {
  const env = {
    PLATFORM_ALERT_CHAT_ID: ' -1001234567890 ',
    PLATFORM_ADMIN_CHAT_ID: '111, -1009998887776',
  } as NodeJS.ProcessEnv;

  it('knows the alert chat and every admin chat', () => {
    expect(isPlatformChat('-1001234567890', env)).toBe(true);
    expect(isPlatformChat('111', env)).toBe(true);
    expect(isPlatformChat('-1009998887776', env)).toBe(true);
  });

  it('leaves every other chat to the login flow', () => {
    expect(isPlatformChat('222', env)).toBe(false);
    expect(isPlatformChat('', {} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('commandOf', () => {
  it('drops the bot name Telegram adds in groups', () => {
    expect(commandOf('/start@kpos_bot')).toBe('/start');
    expect(commandOf('/logout')).toBe('/logout');
  });

  it('leaves plain text alone, even with an @', () => {
    expect(commandOf('salom@dokon')).toBe('salom@dokon');
  });
});
