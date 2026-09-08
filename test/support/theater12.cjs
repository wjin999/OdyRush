"use strict";
// Synthetic geometry transcribed from the user's screenshot, not a live site fixture.
const rows = "A B C D E F G H J K M N O P Q R".split(" ");
function makeTheater12() {
  const seats = [];
  for (const [index, row] of rows.entries()) {
    const premium = ["G", "N"].includes(row);
    const grand = row === "R";
    const centerCount = premium ? 12 : grand ? 10 : 20;
    const blocks = [
      Array.from({length:10}, (_,i) => ({number:i+1,x:75+i*16})),
      Array.from({length:centerCount}, (_,i) => ({number:i+11,x:255+i*(308/(centerCount-1))})),
      Array.from({length:10}, (_,i) => ({number:i+31,x:599+i*16})),
    ];
    for (const [block, values] of blocks.entries()) for (const {number,x} of values) {
      seats.push({row,number,label:`${row}${number}`,x,y:100+index*28,
        available:true,selected:false,special:false,
        seatClass:block===1 ? premium ? "premium" : grand ? "grand" : "standard" : "standard"});
    }
  }
  return seats;
}
module.exports = {makeTheater12};
