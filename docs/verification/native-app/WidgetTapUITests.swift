import XCTest

/// Taps the AgentsWidget instances already placed on the home screen (page 0: small at
/// the top left, medium below it) and checks the app opens on the linked screen.
final class WidgetTapUITests: XCTestCase {
  let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
  let app = XCUIApplication(bundleIdentifier: "dev.ivanbaev.remotecontrol")

  override func setUp() { continueAfterFailure = false }

  private func shot(_ name: String) {
    let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    a.name = name
    a.lifetime = .keepAlways
    add(a)
  }

  private func home() {
    XCUIDevice.shared.press(.home)
    sleep(1)
    app.terminate()
    XCUIDevice.shared.press(.home)
    sleep(2)
  }

  private func tap(_ x: CGFloat, _ y: CGFloat) {
    springboard.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y)).tap()
  }

  private func expectScreen(_ title: String, _ name: String) {
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))
    let found = app.staticTexts[title].waitForExistence(timeout: 15)
    shot(name)
    XCTAssertTrue(found, "expected \(title)")
  }

  func test1MediumRowOpensItsSession() {
    home()
    shot("home")
    tap(0.5, 0.434)  // medium widget, second row: marketing-site
    expectScreen("marketing-site", "medium-row-marketing-site")
  }

  func test2MediumThirdRowOpensItsSession() {
    home()
    tap(0.5, 0.476)  // medium widget, third row: infra
    expectScreen("infra", "medium-row-infra")
  }

  func test3SmallOpensMostUrgent() {
    home()
    tap(0.27, 0.2)  // small widget: links the most urgent waiting session
    expectScreen("billing-api", "small-billing-api")
  }

  private func openControlCenter() {
    springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.005))
      .press(forDuration: 0.1, thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.6)))
    sleep(2)
  }

  func test4ControlCenterControlOpensMostUrgent() {
    home()
    openControlCenter()
    let control = springboard.buttons["dev.ivanbaev.remotecontrol.waiting"]
    if !control.exists {
      springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85)).press(forDuration: 1.5)
      sleep(2)
      springboard.buttons["Add a Control"].tap()
      sleep(2)
      let search = springboard.searchFields.firstMatch
      XCTAssertTrue(search.waitForExistence(timeout: 5))
      search.tap()
      search.typeText("remote-control")
      sleep(2)
      shot("cc-gallery")
      springboard.icons["Agents waiting"].tap()
      sleep(2)
      shot("cc-added")
      // Leave edit mode, then Control Center.
      springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.97)).tap()
      sleep(1)
      XCUIDevice.shared.press(.home)
      sleep(2)
      openControlCenter()
    }
    XCTAssertTrue(control.waitForExistence(timeout: 5))
    shot("cc-control")
    print("CONTROL-LABEL \(control.label)")
    control.tap()
    expectScreen("billing-api", "cc-billing-api")
  }
}
