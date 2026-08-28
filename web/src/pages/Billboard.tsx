import {PixelCard} from "../components/PixelCard/PixelCard";
import {PixelButton} from "../components/PixelButton/PixelButton";
import {useSubscribe} from "@nostr-dev-kit/react";
import {NDKKind} from "@nostr-dev-kit/ndk";
import TextRenderer from "../components/TextRenderer/TextRenderer";
import {UserProfileInline} from "../components/UserProfileInline/UserProfileInline";
import {AddAdModal} from "../components/AddAdModal/AddAdModal";
import {useState} from "react";

const ads = [
    { id: 1, title: "Learn Spanish Fast", description: "Interactive lessons from native speakers 🌎", icon: "🗣️" },
    { id: 2, title: "E-Book Sale", description: "Top 100 bestsellers at 50% off this week 📚 Grab your favorites now before the sale ends!", icon: "📖" },
    { id: 3, title: "Virtual Yoga", description: "Join live classes from home 🧘‍♀️", icon: "🖥️" },
    { id: 4, title: "Online Guitar Lessons", description: "Play your first song in a week 🎸 Beginner-friendly, step-by-step guidance, and personalized feedback included.", icon: "🎶" },
    { id: 5, title: "Freelance Jobs", description: "Remote gigs for designers, writers & coders 💻 Check daily for new opportunities that match your skills.", icon: "📝" },
    { id: 6, title: "Digital Art Workshop", description: "Create stunning illustrations online 🎨 Learn techniques from professional artists and share your work with a global community.", icon: "🖌️" },
    { id: 7, title: "Fitness at Home", description: "Quick workouts for busy schedules 🏋️‍♂️ No equipment needed, perfect for beginners and advanced users alike.", icon: "🔥" },
    { id: 8, title: "Virtual Escape Room", description: "Solve puzzles with friends online 🕵️‍♀️ Test your logic, teamwork, and creativity in an immersive virtual environment.", icon: "🗝️" },
    { id: 9, title: "Recipe Sharing", description: "Discover & share delicious online recipes 🍲 From quick weeknight dinners to gourmet meals, find something for every taste.", icon: "🍴" },
    { id: 10, title: "Meditation App", description: "Daily guided sessions for stress relief 🌸 Short meditations to fit your day or longer sessions for deep relaxation.", icon: "🧘" },
    { id: 11, title: "Online Book Club", description: "Monthly virtual discussions & author Q&A 📚 Connect with fellow readers, share thoughts, and explore new genres.", icon: "💬" },
    { id: 12, title: "Gaming Tournaments", description: "Compete online for prizes 🎮 Join a variety of games and test your skills against players worldwide.", icon: "🏆" },
    { id: 13, title: "Language Exchange", description: "Practice new languages with people worldwide 🌐 Short chats, long conversations, and fun activities included.", icon: "🗺️" },
    { id: 14, title: "Online Music Jam", description: "Collaborate with musicians from everywhere 🎵 Record, mix, and share your music with a global community.", icon: "🎧" },
    { id: 15, title: "Photography Workshop", description: "Improve your photography skills with hands-on lessons and field trips 📸 Learn composition, lighting, and editing techniques.", icon: "📷" }
];

// ==================== MAIN PAGE ====================

export default function Billboard() {
    const {events} = useSubscribe([{kinds: [NDKKind.Text]}]);
    const [isModalOpen, setIsModalOpen] = useState(false);

    return (
        <div className="w-full md:max-w-[90%] lg:max-w-[78%] m-auto min-h-screen bg-[#05010d] text-cyan-300 font-mono px-4 md:px-6 py-10">
            {/* HEADER */}
            <header className="text-center mb-12">
                <h1 className="text-3xl sm:text-4xl md:text-5xl text-pink-500 tracking-widest">
                    HOLOBOARD.SPACE
                </h1>
                <div className="flex justify-center gap-2 sm:gap-4 mt-8">
                    <PixelButton label="ADD AD" onClick={() => setIsModalOpen(true)} />
                    {/* Temporarily hidden - not yet functional */}
                    {/* <PixelButton label="CATEGORIES" /> */}
                    {/* <PixelButton label="FILTER" /> */}
                </div>
            </header>

            <main className="overflow-y-auto flex-1 space-y-4 pr-1">
                {events.map((ad, index) => {
                    // Kolory tła i tekstu losowo lub na podstawie indexu
                    const bgColors = ["bg-pink-900/30", "bg-cyan-900/30", "bg-purple-900/30", "bg-green-900/30"];
                    const textColors = ["text-pink-400", "text-cyan-300", "text-purple-400", "text-green-300"];
                    const bgColor = bgColors[index % bgColors.length];
                    const textColor = textColors[index % textColors.length];

                    return (
                        <PixelCard key={ad.id} className={`flex items-center p-4 rounded-lg ${bgColor} hover:scale-105 transition-transform`}>
                            <div className="text-6xl mr-4 flex-shrink-0">{ads[index]?.icon}</div>
                            <div className="flex-1 min-w-0">
                                <h2 className={`text-xl font-bold mb-1 tracking-wider ${textColor}`}>
                                    <UserProfileInline pubkey={ad.pubkey}/>
                                </h2>
                                <div className="text-sm text-white/80 break-words overflow-hidden">
                                    <TextRenderer text={ad.content}/>
                                </div>
                            </div>
                        </PixelCard>
                    );
                })}
            </main>

            {/* FOOTER ACTION */}
            <div className="flex justify-center mt-16">
                <PixelButton label="ADD AD" onClick={() => setIsModalOpen(true)} />
            </div>

            {/* ADD AD MODAL */}
            <AddAdModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} />
        </div>
    );
}