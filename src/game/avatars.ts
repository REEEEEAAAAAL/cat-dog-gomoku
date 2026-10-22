export function avatar(animal: 'dog' | 'cat'): string {
  const ears = animal === 'dog'
    ? '<path d="M22 24C3 14 1 44 15 48L27 35M58 24C77 14 79 44 65 48L53 35" fill="#BA845A"/>'
    : '<path d="M19 34L17 9L38 24M61 34L63 9L42 24" fill="#8DA99A"/><path d="M22 25L21 16L30 26M58 25L59 16L50 26" fill="#E8B7A6"/>';
  return `<svg viewBox="0 0 80 80" class="avatar" aria-hidden="true"><circle cx="40" cy="40" r="39" fill="${animal === 'dog' ? '#F3E4CB' : '#E0E9DE'}"/>${ears}<ellipse cx="40" cy="43" rx="25" ry="24" fill="${animal === 'dog' ? '#E3BC89' : '#A4BAAB'}"/><ellipse cx="40" cy="51" rx="15" ry="12" fill="#F8F3E7"/><circle cx="30" cy="41" r="2.6" fill="#2B3B35"/><circle cx="50" cy="41" r="2.6" fill="#2B3B35"/><path d="M36 49Q40 46 44 49L40 53Z" fill="#5A4438"/><path d="M40 53V57M40 57Q35 61 32 56M40 57Q45 61 48 56" fill="none" stroke="#5A4438" stroke-width="1.7" stroke-linecap="round"/>${animal === 'cat' ? '<path d="M22 50L9 47M22 55L8 57M58 50L71 47M58 55L72 57" stroke="#60766B" stroke-width="1.4"/>' : ''}</svg>`;
}
