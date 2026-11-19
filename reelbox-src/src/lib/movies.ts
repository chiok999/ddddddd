/**
 * The catalog.
 *
 * Reconstructed from the compiled build, where the this data was also generated
 * in a loop rather than written out as a literal. Replace `titles` with a real
 * provider when the app is wired to one; everything downstream reads this array.
 */

export type TitleType = 'Movie' | 'TV Series' | 'Anime';

export interface Title {
  id: string;
  title: string;
  year: number;
  type: TitleType;
  genres: string[];
  rating: number;
  duration: string;
  country: string;
  description: string;
  poster: string;
  backdrop: string;
  cast: string[];
  seasons?: number;
}

export const genres = [
  'Action',
  'Drama',
  'Comedy',
  'Thriller',
  'Sci-Fi',
  'Romance',
  'Horror',
  'Animation',
  'Crime',
  'Adventure',
] as const;

const names = [
  'Midnight Harbor',
  'Crimson Tide Rising',
  'The Last Orbit',
  'Silent Echoes',
  'Neon Streets',
  'Kingdom of Ash',
  'Golden Hour',
  'Shadow Protocol',
  'Wild Hearts',
  'Frozen Signal',
  'Desert Rose',
  'Lost in Lagos',
  'Iron Valley',
  'Paper Moons',
  'The Hollow Crown',
  'Velocity',
  'Ocean Between Us',
  'Night Market',
  'Ghost Frequency',
  'Summer in Seoul',
  'Blood & Silver',
  'Starfall',
  'The Quiet Ones',
  'Electric Dreams',
];

const actors = [
  'Ava Stone',
  'Leo Mensah',
  'Mira Chen',
  'Daniel Okafor',
  'Sofia Reyes',
  'Kenji Ito',
  'Zara Ali',
  'Noah Brooks',
];

const countries = ['USA', 'Nigeria', 'Korea', 'UK', 'Japan', 'India'];

export const titles: Title[] = names.map((title, i) => ({
  id: String(i + 1),
  title,
  year: 2018 + (i % 9),
  type: i % 5 === 0 ? 'TV Series' : i % 7 === 0 ? 'Anime' : 'Movie',
  genres: [genres[i % 10], genres[(i + 3) % 10]],
  rating: +(6 + ((i * 7) % 35) / 10).toFixed(1),
  duration: `${90 + ((i * 11) % 60)}m`,
  country: countries[i % 6],
  description: `${title} follows an unlikely group pulled into a story of loyalty, risk and second chances, where every choice could change everything.`,
  poster: `https://picsum.photos/seed/mb${i}/400/600`,
  backdrop: `https://picsum.photos/seed/mbb${i}/1600/800`,
  cast: [actors[i % 8], actors[(i + 2) % 8], actors[(i + 5) % 8]],
  seasons: i % 5 === 0 ? 1 + (i % 3) : undefined,
}));

export const getTitle = (id: string) => titles.find((t) => t.id === id);

export interface Section {
  name: string;
  items: Title[];
}

export const sections: Section[] = [
  { name: 'Trending Now', items: titles.slice(0, 10) },
  { name: 'Hot Movies', items: titles.filter((t) => t.type === 'Movie').slice(0, 10) },
  { name: 'Popular Series', items: titles.filter((t) => t.type !== 'Movie') },
  { name: 'Top Rated', items: [...titles].sort((a, b) => b.rating - a.rating).slice(0, 10) },
  { name: 'New Releases', items: [...titles].sort((a, b) => b.year - a.year).slice(0, 10) },
];

/**
 * The build shipped one sample file for every title. Named for what it is so
 * nothing downstream mistakes it for real provider integration.
 */
export const VIDEO =
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
