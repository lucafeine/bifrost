import EmojiMapper from '../emojiMapping/EmojiMapper';
import { GeneralEmoji } from '../../utils/emojis';

export default abstract class MessageTransformer<SourceMessage, TargetMessage> {
    protected readonly emojiMapper: EmojiMapper;

    constructor(emojiMapper?: EmojiMapper) {
        this.emojiMapper = emojiMapper ?? new EmojiMapper();
    }

    abstract transformMessage(
        message: SourceMessage,
        otherEmojis?: GeneralEmoji[]
    ): Promise<TargetMessage>;

    protected replaceEmojis(content: string, emojis: GeneralEmoji[]): string {
        return this.emojiMapper.mapContent(content, emojis);
    }
}
