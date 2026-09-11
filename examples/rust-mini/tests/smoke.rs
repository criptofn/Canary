// An integration test, so `cargo test` exercises both the unit test in src/ and
// this crate-external one.
use canary_example_rust::add;

#[test]
fn adds_from_outside() {
    assert_eq!(add(2, 3), 5);
}
