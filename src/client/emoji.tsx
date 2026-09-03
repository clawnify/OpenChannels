import { useState } from "react";
import { Smile } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./components/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./components/command";

/**
 * The emoji offered in the composer.
 *
 * Curated rather than complete: a full emoji library costs a few hundred
 * kilobytes and an index of every codepoint to solve a problem nobody replying
 * to a guest has. Every entry carries keywords because the glyph itself is not
 * searchable text — without them, typing "party" finds nothing.
 */
type Emoji = { char: string; keywords: string[] };

const GROUPS: { label: string; emoji: Emoji[] }[] = [
  {
    label: "Smileys",
    emoji: [
      { char: "😀", keywords: ["grin", "happy", "smile"] },
      { char: "😄", keywords: ["happy", "smile", "joy"] },
      { char: "😁", keywords: ["beam", "grin", "happy"] },
      { char: "😆", keywords: ["laugh", "haha", "lol"] },
      { char: "😂", keywords: ["laugh", "cry", "lol", "funny"] },
      { char: "🤣", keywords: ["rofl", "laugh", "funny"] },
      { char: "🙂", keywords: ["smile", "slight"] },
      { char: "😉", keywords: ["wink"] },
      { char: "😊", keywords: ["blush", "smile", "happy"] },
      { char: "🥰", keywords: ["love", "hearts", "adore"] },
      { char: "😍", keywords: ["love", "heart eyes"] },
      { char: "😘", keywords: ["kiss", "love"] },
      { char: "😋", keywords: ["yum", "tasty", "delicious"] },
      { char: "🤗", keywords: ["hug", "welcome"] },
      { char: "🤔", keywords: ["think", "hmm", "wondering"] },
      { char: "🙄", keywords: ["eyeroll", "whatever"] },
      { char: "😅", keywords: ["sweat", "phew", "relief"] },
      { char: "😬", keywords: ["grimace", "awkward", "eek"] },
      { char: "🥲", keywords: ["tear", "bittersweet"] },
      { char: "😴", keywords: ["sleep", "tired", "zzz"] },
      { char: "🥳", keywords: ["party", "celebrate", "birthday"] },
      { char: "😎", keywords: ["cool", "sunglasses"] },
      { char: "😢", keywords: ["sad", "cry", "sorry"] },
      { char: "😱", keywords: ["shock", "scream", "omg"] },
    ],
  },
  {
    label: "Gestures",
    emoji: [
      { char: "👍", keywords: ["thumbs up", "yes", "ok", "great"] },
      { char: "👎", keywords: ["thumbs down", "no"] },
      { char: "👌", keywords: ["ok", "perfect", "fine"] },
      { char: "✌️", keywords: ["peace", "victory"] },
      { char: "🤞", keywords: ["fingers crossed", "hope", "luck"] },
      { char: "🙏", keywords: ["please", "thanks", "thank you", "pray"] },
      { char: "👏", keywords: ["clap", "applause", "well done"] },
      { char: "🙌", keywords: ["celebrate", "hooray", "praise"] },
      { char: "🤝", keywords: ["handshake", "deal", "agree"] },
      { char: "💪", keywords: ["strong", "muscle", "power"] },
      { char: "👋", keywords: ["wave", "hi", "hello", "bye"] },
      { char: "🫶", keywords: ["heart hands", "love", "thanks"] },
    ],
  },
  {
    label: "Hearts & marks",
    emoji: [
      { char: "❤️", keywords: ["heart", "love", "red"] },
      { char: "🧡", keywords: ["heart", "orange"] },
      { char: "💛", keywords: ["heart", "yellow"] },
      { char: "💚", keywords: ["heart", "green"] },
      { char: "💙", keywords: ["heart", "blue"] },
      { char: "💜", keywords: ["heart", "purple"] },
      { char: "🖤", keywords: ["heart", "black"] },
      { char: "🤍", keywords: ["heart", "white"] },
      { char: "💖", keywords: ["heart", "sparkle", "love"] },
      { char: "✨", keywords: ["sparkles", "shiny", "magic"] },
      { char: "⭐", keywords: ["star", "favourite"] },
      { char: "🌟", keywords: ["star", "glowing", "shine"] },
      { char: "🔥", keywords: ["fire", "hot", "lit"] },
      { char: "💯", keywords: ["hundred", "perfect", "score"] },
      { char: "✅", keywords: ["check", "done", "yes", "tick"] },
      { char: "❌", keywords: ["cross", "no", "wrong", "cancel"] },
      { char: "⚠️", keywords: ["warning", "careful", "alert"] },
      { char: "❗", keywords: ["exclamation", "important"] },
      { char: "❓", keywords: ["question", "ask"] },
      { char: "💬", keywords: ["speech", "chat", "message"] },
    ],
  },
  {
    label: "Celebrate",
    emoji: [
      { char: "🎉", keywords: ["party", "tada", "celebrate", "congrats"] },
      { char: "🎊", keywords: ["confetti", "party", "celebrate"] },
      { char: "🥂", keywords: ["cheers", "toast", "champagne", "drinks"] },
      { char: "🍾", keywords: ["champagne", "bottle", "celebrate"] },
      { char: "🍻", keywords: ["beer", "cheers", "drinks"] },
      { char: "🍷", keywords: ["wine", "drinks"] },
      { char: "🎂", keywords: ["cake", "birthday"] },
      { char: "🍰", keywords: ["cake", "dessert", "slice"] },
      { char: "☕", keywords: ["coffee", "cafe"] },
      { char: "🍵", keywords: ["tea", "matcha"] },
    ],
  },
  {
    label: "Food",
    emoji: [
      { char: "🍽️", keywords: ["dinner", "table", "plate", "eat", "restaurant"] },
      { char: "🍕", keywords: ["pizza", "food"] },
      { char: "🍝", keywords: ["pasta", "italian", "food"] },
      { char: "🍜", keywords: ["noodles", "ramen", "food"] },
      { char: "🥗", keywords: ["salad", "healthy", "veg"] },
      { char: "🍣", keywords: ["sushi", "japanese", "food"] },
      { char: "🌮", keywords: ["taco", "mexican", "food"] },
      { char: "🥐", keywords: ["croissant", "breakfast", "pastry"] },
      { char: "🧀", keywords: ["cheese"] },
      { char: "🍫", keywords: ["chocolate", "sweet"] },
    ],
  },
  {
    label: "Practical",
    emoji: [
      { char: "📅", keywords: ["calendar", "date", "schedule"] },
      { char: "⏰", keywords: ["clock", "time", "reminder", "alarm"] },
      { char: "📍", keywords: ["pin", "location", "address", "where"] },
      { char: "🏠", keywords: ["home", "house", "venue"] },
      { char: "🚗", keywords: ["car", "drive", "travel"] },
      { char: "✈️", keywords: ["plane", "flight", "travel"] },
      { char: "📸", keywords: ["camera", "photo", "picture"] },
      { char: "🎵", keywords: ["music", "note", "song"] },
      { char: "📝", keywords: ["note", "write", "memo"] },
      { char: "🔗", keywords: ["link", "url"] },
      { char: "📩", keywords: ["email", "message", "inbox"] },
      { char: "🎟️", keywords: ["ticket", "booking", "rsvp"] },
    ],
  },
];

export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Insert emoji"
          className="inline-flex size-8 items-center justify-center rounded-sm text-muted transition-colors duration-150 hover:bg-sunken hover:text-foreground"
        >
          <Smile className="size-4" aria-hidden />
        </button>
      </PopoverTrigger>
      {/* Above the composer, which sits at the bottom of the window. Radix
          flips it automatically if there is no room, so this is a preference
          rather than a constraint. */}
      <PopoverContent side="top" align="start" className="w-64 p-0">
        <Command
          // Emoji glyphs are not words, so the default substring filter never
          // matches; the keywords on each item are what search actually reads.
          loop
        >
          <CommandInput placeholder="Search emoji…" />
          <CommandList>
            <CommandEmpty>No emoji found.</CommandEmpty>
            {GROUPS.map((group) => (
              <CommandGroup
                key={group.label}
                heading={group.label}
                // cmdk renders each group's items into this element; making it
                // the grid keeps the list semantics and gets the layout.
                className="[&_[cmdk-group-items]]:grid [&_[cmdk-group-items]]:grid-cols-8 [&_[cmdk-group-items]]:gap-0.5"
              >
                {group.emoji.map((emoji) => (
                  <CommandItem
                    key={emoji.char}
                    value={emoji.char}
                    keywords={emoji.keywords}
                    onSelect={() => {
                      onPick(emoji.char);
                      setOpen(false);
                    }}
                    aria-label={emoji.keywords[0]}
                    className="flex size-7 items-center justify-center text-base leading-none"
                  >
                    {emoji.char}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
