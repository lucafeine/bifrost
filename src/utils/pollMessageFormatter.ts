const NUMBER_EMOJIS = [
    '1️⃣',
    '2️⃣',
    '3️⃣',
    '4️⃣',
    '5️⃣',
    '6️⃣',
    '7️⃣',
    '8️⃣',
    '9️⃣',
    '🔟',
];

export const getPollMessage = (
    question: string,
    options: string[],
    endsAt: number
): string => {
    const optionsText = options
        .map((option, index) => {
            const marker = NUMBER_EMOJIS[index] ?? `${index + 1}.`;
            return `${marker} ${option}`;
        })
        .join('\n');

    const endsAtTimestamp = Math.floor(endsAt / 1000);
    const endsAtText = `-# Poll ends <t:${endsAtTimestamp}:R>`;
    const infoText =
        '-# Created on Discord — react with the matching number to vote. Votes sync back as reactions. The poll itself can only be answered on Discord.';

    return `📊 **${question}**\n${optionsText}\n${endsAtText}\n${infoText}`;
};
