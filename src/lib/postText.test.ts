import { describe, expect, it } from 'vitest';
import { captionTitle, isBoilerplateTitle, isPostLink, parsePostDescription, parsePostTitle, postingDay, stripPostBoilerplate } from './postText';

// Display width as captionTitle counts it: CJK, kana, hangul, full-width forms and emoji take two columns.
const width = (s: string) =>
  Array.from(s).reduce((w, c) => w + (/[\p{M}‍️]/u.test(c) ? 0 : /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-｠\p{Extended_Pictographic}]/u.test(c) ? 2 : 1), 0);

describe('parsePostDescription', () => {
  it('reads Instagram descriptions', () => {
    expect(parsePostDescription('1,234 likes, 56 comments - mei.eats on March 5, 2026: “Best dim sum in Mong Kok 🥟 #dimsum #hongkong”.')).toEqual({
      caption: 'Best dim sum in Mong Kok 🥟 #dimsum #hongkong',
      handle: 'mei.eats',
      publishedAt: '2026-03-05',
    });
    // Abbreviated counts, quotes the "wrong" way round, a single comment.
    expect(parsePostDescription('18K likes, 1 comments - walk_hk on September 7, 2026: ”Sunrise hike up Lion Rock“.')).toEqual({
      caption: 'Sunrise hike up Lion Rock',
      handle: 'walk_hk',
      publishedAt: '2026-09-07',
    });
    expect(parsePostDescription('1.2M likes, 3,400 comments - big.channel on 7 September 2026: "Hello"')?.publishedAt).toBe('2026-09-07');
  });

  it('copes with a missing counts part, a missing caption and a caption cut short', () => {
    expect(parsePostDescription('tea.time on October 1, 2026: “Five teahouses worth the queue”')).toEqual({
      caption: 'Five teahouses worth the queue',
      handle: 'tea.time',
      publishedAt: '2026-10-01',
    });
    expect(parsePostDescription('48K likes, 12K comments - tea.time on October 1, 2026')).toEqual({ handle: 'tea.time', publishedAt: '2026-10-01' });
    expect(parsePostDescription('9 likes, 0 comments - tea.time on October 1, 2026: “A very long caption that the service cut off in the mid')?.caption).toBe(
      'A very long caption that the service cut off in the mid',
    );
  });

  it('keeps the caption’s line breaks', () => {
    expect(parsePostDescription('5 likes, 1 comment - a.b on May 1, 2026: “Line one\n\n\n📍 Somewhere\nLine three”.')?.caption).toBe('Line one\n\n📍 Somewhere\nLine three');
  });

  it('reads the Chinese, Japanese and Korean forms', () => {
    expect(parsePostDescription('1,234 個讚、56 則留言 - mei.eats 於 2026年10月3日:「深水埗三間必食小店」')).toEqual({
      caption: '深水埗三間必食小店',
      handle: 'mei.eats',
      publishedAt: '2026-10-03',
    });
    expect(parsePostDescription('1,234 次赞、56 条评论 - mei.eats 于 2026年10月3日：“广州早茶推荐”')?.caption).toBe('广州早茶推荐');
    expect(parsePostDescription('いいね！1,234件、コメント56件 - mei.eats - 2026年10月3日: 「京都の紅葉」')?.caption).toBe('京都の紅葉');
    expect(parsePostDescription('좋아요 1,234개, 댓글 56개 - mei.eats님, 2026년 10월 3일: "서울 카페"')?.publishedAt).toBe('2026-10-03');
  });

  it('reads the older Instagram and TikTok forms', () => {
    expect(parsePostDescription('1,234 Likes, 56 Comments - Mei Chan (@mei.eats) on Instagram: "Egg tarts, ranked"')).toEqual({
      caption: 'Egg tarts, ranked',
      author: 'Mei Chan',
      handle: 'mei.eats',
    });
    expect(parsePostDescription('1.2M Likes, 3,456 Comments. TikTok video from Mei Chan (@mei.eats): "Crispy pork belly #recipe". original sound - mei.eats')).toEqual({
      caption: 'Crispy pork belly #recipe',
      author: 'Mei Chan',
      handle: 'mei.eats',
      kind: 'video',
    });
  });

  it('leaves other text alone', () => {
    expect(parsePostDescription('Crisp, airy focaccia with rosemary.')).toBeUndefined();
    expect(parsePostDescription('Updated on March 5, 2026: new opening hours')).toBeUndefined();
    expect(parsePostDescription('Follow us on Instagram: @brand')).toBeUndefined();
    expect(parsePostDescription('')).toBeUndefined();
    // Not a real day.
    expect(parsePostDescription('5 likes, 1 comment - a.b on February 30, 2026: "Hi"')).toEqual({ caption: 'Hi', handle: 'a.b' });
  });
});

describe('parsePostTitle', () => {
  it('reads account titles', () => {
    expect(parsePostTitle('Mei Chan (@mei.eats) • Instagram reel')).toEqual({ author: 'Mei Chan', handle: 'mei.eats', kind: 'reel' });
    expect(parsePostTitle('美食日記 | 香港 (@mei.eats) • Instagram photo')).toEqual({ author: '美食日記 | 香港', handle: 'mei.eats', kind: 'photo' });
    expect(parsePostTitle('Mei Chan (@mei.eats) • Instagram photos and videos')).toEqual({ author: 'Mei Chan', handle: 'mei.eats' });
    expect(parsePostTitle('Mei Chan (@mei.eats) on Threads')).toEqual({ author: 'Mei Chan', handle: 'mei.eats' });
    expect(parsePostTitle('Mei Chan (@mei.eats) | TikTok')).toEqual({ author: 'Mei Chan', handle: 'mei.eats' });
    expect(parsePostTitle('Instagram reel')).toEqual({ kind: 'reel' });
    expect(parsePostTitle('Instagram')).toEqual({});
    expect(parsePostTitle('Instagram post by Mei Chan • Mar 5, 2026 at 10:00 AM')).toEqual({ kind: 'post', author: 'Mei Chan', publishedAt: '2026-03-05' });
    expect(parsePostTitle('Reel by Mei Chan | Facebook')).toEqual({ kind: 'reel', author: 'Mei Chan' });
  });

  it('reads titles that carry the caption', () => {
    expect(parsePostTitle('Mei Chan on Instagram: "Egg tarts, ranked"')).toEqual({ caption: 'Egg tarts, ranked', author: 'Mei Chan' });
    expect(parsePostTitle('@mei.eats on Instagram: “Egg tarts”')).toEqual({ caption: 'Egg tarts', handle: 'mei.eats' });
    expect(parsePostTitle('12K views · 345 reactions | Best noodles in Jordan | By Mei Chan | Facebook')).toEqual({
      caption: 'Best noodles in Jordan',
      author: 'Mei Chan',
    });
    expect(parsePostTitle('Mei Chan on X: "Typhoon signal 8 is up" / X')).toEqual({ caption: 'Typhoon signal 8 is up', author: 'Mei Chan' });
  });

  it('leaves other titles alone', () => {
    expect(parsePostTitle('The best focaccia | BBC Good Food')).toBeUndefined();
    expect(parsePostTitle('How to grow on Instagram')).toBeUndefined();
    expect(parsePostTitle('Instagram Marketing for Small Shops')).toBeUndefined();
    expect(parsePostTitle('')).toBeUndefined();
  });
});

describe('isBoilerplateTitle', () => {
  it('spots titles that only name an account or a platform', () => {
    for (const t of [
      'Mei Chan (@mei.eats) • Instagram reel',
      'Instagram reel',
      'Instagram photo',
      'Instagram post',
      'Instagram',
      'Facebook',
      'Threads',
      'Login • Instagram',
      'Instagram: Log in',
      'Page not found • Instagram',
      'Mei Chan (@mei.eats) on Threads',
      'Reel by Mei Chan | Facebook',
      '',
      '   ',
      undefined,
    ]) {
      expect(isBoilerplateTitle(t), String(t)).toBe(true);
    }
  });

  it('keeps real titles', () => {
    for (const t of ['Best dim sum in Mong Kok', 'Mei Chan on Instagram: "Egg tarts"', 'Instagram Marketing for Small Shops', 'Log in to the future', '香港日落好去處']) {
      expect(isBoilerplateTitle(t), t).toBe(false);
    }
  });
});

describe('stripPostBoilerplate', () => {
  it('keeps only the caption of a post description', () => {
    expect(stripPostBoilerplate('2,019 likes, 77 comments - mei.eats on June 2, 2026: “Open Fri–Sun 11:00-23:00 #cafe”.')).toBe('Open Fri–Sun 11:00-23:00 #cafe');
    expect(stripPostBoilerplate('48K likes, 12K comments - mei.eats on June 2, 2026')).toBe('');
    expect(stripPostBoilerplate('1,234 個讚、56 則留言 - mei.eats 於 2026年10月3日:「中秋市集」')).toBe('中秋市集');
  });

  it('drops account-only title lines and keeps everything else', () => {
    const text = ['Mei Chan (@mei.eats) • Instagram reel', '9 likes, 1 comment - mei.eats on May 1, 2026: “Pop-up store', 'Dates: 3/11 – 30/11”.', 'my note'].join('\n');
    expect(stripPostBoilerplate(text)).toBe('Pop-up store\nDates: 3/11 – 30/11\nmy note');
  });

  it('returns other text unchanged', () => {
    for (const t of ['Party on March 5, 2026: bring snacks', 'Jazz night Sat 12 Oct, 9pm', 'Follow us on Instagram', '']) {
      expect(stripPostBoilerplate(t)).toBe(t);
    }
  });
});

describe('captionTitle', () => {
  it('takes the first sentence, keeping 【】 headings', () => {
    expect(captionTitle('【食在深水埗】五間平靚正小店 一次過介紹！\n— — — —\n平日去唔使排隊')).toBe('【食在深水埗】五間平靚正小店 一次過介紹！');
    expect(captionTitle('今日終於食到傳說中的「芒果糯米飯」。真係好正。')).toBe('今日終於食到傳說中的「芒果糯米飯」');
    expect(captionTitle('The view from the top was unreal. We started at 5am and it was worth it.')).toBe('The view from the top was unreal');
  });

  it('drops hashtags, @mentions, links and trailing emoji', () => {
    expect(captionTitle('#tbt #summer Our first trip to Lisbon together 💛')).toBe('Our first trip to Lisbon together');
    expect(captionTitle('一篇教你點樣儲錢😉 #理財 #儲錢')).toBe('一篇教你點樣儲錢');
    expect(captionTitle('So happy with this haul from @shop.hk 🛍️ #haul')).toBe('So happy with this haul');
    expect(captionTitle('三個香港日落好去處 全文：https://example.com/abc')).toBe('三個香港日落好去處');
    expect(captionTitle('New recipe https://example.com/r 🍋')).toBe('New recipe');
    expect(captionTitle('終於去到夢想中的島嶼🤩！')).toBe('終於去到夢想中的島嶼！');
    expect(captionTitle('#好物推介➠夏天必備的防曬三寶？')).toBe('夏天必備的防曬三寶？');
    expect(captionTitle('【#生活資訊】三分鐘學識整蛋撻')).toBe('【生活資訊】三分鐘學識整蛋撻');
  });

  it('skips low-information openers when something better follows', () => {
    expect(captionTitle('EP 3 | Learning to laminate dough for croissants #baking #croissant')).toBe('Learning to laminate dough for croissants');
    expect(captionTitle('Part 2 is up! Which one would you try?? Reading list: The Hobbit, Dune, Circe')).toBe('Reading list: The Hobbit, Dune, Circe');
    expect(captionTitle('留言「食譜」我send完整步驟俾你📩\n一鍋到底的番茄牛肉意粉，十五分鐘搞掂！')).toBe('一鍋到底的番茄牛肉意粉，十五分鐘搞掂！');
    expect(captionTitle('（連結喺主頁） 呢對耳機用咗半年嘅真實感受')).toBe('呢對耳機用咗半年嘅真實感受');
    expect(captionTitle('Kyoto / 京都 Please follow for more 🍁')).toBe('Kyoto / 京都');
    // Nothing better: the opener it is.
    expect(captionTitle('Part 2 is up!')).toBe('Part 2 is up!');
  });

  it('splits Chinese captions at emoji, phrases, places and labelled fields', () => {
    expect(captionTitle('東京自由行🗼 必去的隱世咖啡店☕️ 讓你一試難忘 #tokyo')).toBe('東京自由行🗼 必去的隱世咖啡店');
    expect(captionTitle('週末去咗個好靚嘅海灘 📍石澳')).toBe('週末去咗個好靚嘅海灘');
    expect(captionTitle('Snoopy × 7-Eleven 期間限定店 地址：旺角某商場 日期：3/11-30/11')).toBe('Snoopy × 7-Eleven 期間限定店');
    expect(captionTitle('📍Lantau Peak sunrise Directions: 1. MTR to Tung Chung 2. Bus 3M to Pak Kung Au')).toBe('Lantau Peak sunrise');
    // A list on one line ends at its first item, without the next one's number.
    expect(captionTitle('1. Tokyo 2. Osaka 3. Kyoto')).toBe('Tokyo');
    expect(captionTitle('Top 3 noodle bars: 1. Alpha Noodles 2. Beta Ramen')).toBe('Top 3 noodle bars');
    expect(captionTitle('今日分享三個學英文頻道（全部都係免費！）： 1️⃣ 頻道一 2️⃣ 頻道二')).toBe('今日分享三個學英文頻道（全部都係免費！）');
    expect(captionTitle('看看【阿明的作品】三步教你煎出完美溏心蛋！#煎蛋')).toBe('三步教你煎出完美溏心蛋！');
    expect(captionTitle('估唔到吧？「每日行一萬步」原來唔係必要！之後再講')).toBe('估唔到吧？「每日行一萬步」原來唔係必要！');
  });

  it('shortens long captions at a clause or word, CJK counting double', () => {
    const zh = captionTitle('如果你成日覺得膊頭好硬、坐耐咗腰骨痛，其實好可能係盆骨前傾引起嘅問題，今日教你三個簡單動作改善');
    expect(zh).toBe('如果你成日覺得膊頭好硬、坐耐咗腰骨痛，其實好可能係盆骨前傾引起嘅問題…');
    expect(width(zh!)).toBeLessThanOrEqual(70);

    const en = captionTitle('Honestly this might be the most underrated hiking trail on the whole island and nobody talks about it');
    expect(en).toBe('Honestly this might be the most underrated hiking trail on the whole…');
    expect(en!.length).toBeLessThanOrEqual(70);

    // At a bracket's edge rather than inside it.
    expect(captionTitle('台北大稻埕有間百年老茶行最近重新推出咗「桂花烏龍茶」限定版本一共有六款同禮盒')).toBe('台北大稻埕有間百年老茶行最近重新推出咗「桂花烏龍茶」…');

    const short = captionTitle('Honestly this might be the most underrated hiking trail on the island', 30);
    expect(short).toBe('Honestly this might be the…');
    expect(short!.length).toBeLessThanOrEqual(30);
  });

  it('reads fancy Unicode letters as plain ones', () => {
    expect(captionTitle('𝗕𝗲𝘀𝘁 𝗿𝗮𝗺𝗲𝗻 𝗶𝗻 𝗧𝗼𝗸𝘆𝗼 🍜')).toBe('Best ramen in Tokyo');
  });

  it('gives nothing for captions without words', () => {
    expect(captionTitle('')).toBeUndefined();
    expect(captionTitle('#food #yum')).toBeUndefined();
    expect(captionTitle('🔥🔥🔥')).toBeUndefined();
    expect(captionTitle('@someone @another')).toBeUndefined();
  });
});

describe('isPostLink / postingDay', () => {
  it('knows social post links', () => {
    expect(isPostLink('https://www.instagram.com/reel/AbC123/')).toBe(true);
    expect(isPostLink('https://m.facebook.com/story.php?id=1')).toBe(true);
    expect(isPostLink('https://vm.tiktok.com/ZMabc/')).toBe(true);
    expect(isPostLink('https://news.example.com/instagram.com')).toBe(false);
    expect(isPostLink('not a link')).toBe(false);
    expect(isPostLink(undefined)).toBe(false);
  });

  it('reads the dates post wrappers write', () => {
    expect(postingDay('March 5, 2026')).toBe('2026-03-05');
    expect(postingDay('on 5 March 2026')).toBe('2026-03-05');
    expect(postingDay('2026年3月5日')).toBe('2026-03-05');
    expect(postingDay('Tonight 9pm')).toBeUndefined();
  });
});
