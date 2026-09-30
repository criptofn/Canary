// The old implementation crashes on a valid input, without any missing fixture.
module.exports = name => {
  const row = name.startsWith(' ') ? undefined : { name };
  return 'hello ' + row.name;
};
